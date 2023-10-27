'use strict';
/**
* Helpers to mock the AWS SDK Services using sinon.js under the hood
* Export two functions:
* - mock
* - restore
*
* Mocking is done in two steps:
* - mock of the constructor for the service on AWS
* - mock of the method on the service
**/

const sinon = require('sinon');
const traverse = require('traverse');
let AWS_SDK = require('aws-sdk');
const Readable = require('stream').Readable;

let _AWS = AWS_SDK;

// AWS that is exported to the client
const AWS = {
  Promise: global.Promise,
};
const services = {};

/**
 * Sets the aws-sdk to be mocked.
 */
function setSDK(path) {
  _AWS = require(path);
};

AWS.setSDK = setSDK


function setSDKInstance(sdk) {
  _AWS = sdk;
};

AWS.setSDKInstance = setSDKInstance


/**
 * Stubs the service and registers the method that needs to be mocked.
 */
function mock(
  service,
  method,
  replace
) {
  // If the service does not exist yet, we need to create and stub it.
  if (!services[service]) {
    const service_to_add = {
      // Save the real constructor so we can invoke it later on.
      // Uses traverse for easy access to nested services (dot-separated)
      Constructor: traverse(_AWS).get(service.split(".")),
      methodMocks: {},
      invoked: false,
    };

    services[service] = service_to_add;
    mockService(service);
  }

  const service_obj = services[service];
  const methodName = method

  // Register the method to be mocked out.
  if (!service_obj?.methodMocks[methodName]) {
    // Adding passed mock method
    if (service_obj !== undefined) service_obj.methodMocks[methodName] = { replace: replace };

    // If the constructor was already invoked, we need to mock the method here.
    if (service_obj?.invoked) {
      service_obj?.clients?.forEach((client) => {
        mockServiceMethod(service, client, methodName, replace);
      });
    }
  }

  return service_obj?.methodMocks[method];
};

AWS.mock = mock



/**
 * Stubs the service and registers the method that needs to be re-mocked.
 */
function remock(
  service,
  method,
  replace
) {
  // If the method is inside the service, we restore the method
  if (services[service]?.methodMocks[method]) {
    restoreMethod(service, method);

    const service_obj = services[service];
    if (service_obj !== undefined) {
      service_obj.methodMocks[method] = {
        replace: replace,
      };
    }
  }

  const methodName = method
  // We check if the service was invoked or not. If it was, we mock the service method with the `replace` function
  if (services[service]?.invoked) {
    services[service]?.clients?.forEach((client) => {
      mockServiceMethod(service, client, methodName, replace);
    });
  }

  return services[service]?.methodMocks[method];
};

AWS.remock = remock

/**
 * Stub the constructor for the service on AWS.
 * E.g. calls of new AWS.SNS() are replaced.
 */
function mockService(service) {
  const nestedServices = service.split(".");

  const method = nestedServices.pop();
  const object = traverse(_AWS).get(nestedServices);

  // Method type guard
  if (!method) return;

  const service_obj = services[service];

  if (service_obj) {
    const serviceStub = sinon.stub(object, method).callsFake(function (...args) {
      service_obj.invoked = true;

      /**
       * Create an instance of the service by calling the real constructor
       * we stored before. E.g. const client = new AWS.SNS()
       * This is necessary in order to mock methods on the service.
       */
      const client = new service_obj.Constructor(...args);
      service_obj.clients = service_obj.clients || [];
      service_obj.clients.push(client);

      // Once this has been triggered we can mock out all the registered methods.
      for (const key in service_obj.methodMocks) {
        const methodKey = key
        const objectMethodMock = service_obj.methodMocks[key]
        if(objectMethodMock) {
          mockServiceMethod(service, client, methodKey, objectMethodMock.replace);
        }
      }
      return client;
    });
    service_obj.stub = serviceStub;
  }
}

/**
 * Wraps a sinon stub or jest mock function as a fully functional replacement function
 */
function wrapTestStubReplaceFn(replace) {
  if (typeof replace !== 'function' || !(replace._isMockFunction || replace.isSinonProxy)) {
    return replace;
  }

  return (params, cb) => {
    // If only one argument is provided, it is the callback
    let callback
    if(cb === undefined || !cb) {
      callback = params;
    } 
    
    // If not, the callback is the passed cb
    else {
      callback = cb
    }
    
    // Spy on the users callback so we can later on determine if it has been called in their replace
    const cbSpy = sinon.spy(callback);
    try {
      // The replace function can also be a `functionStub`.
      // Call the users replace, check how many parameters it expects to determine if we should pass in callback only, or also parameters
      const result = replace.length === 1 ? replace(cbSpy) : replace(params, cbSpy);
      // If the users replace already called the callback, there's no more need for us do it.
      if (cbSpy.called) {
          return;
      }
      if (typeof result.then === 'function') {
        result.then((val) => callback(undefined, val), (err) => callback(err));
      } else {
        callback(undefined, result);
      }
    } catch (err) {
      callback(err);
    }
  };
}

/**
 *  Stubs the method on a service.
 *
 * All AWS service methods take two argument:
 *  - params: an object.
 *  - callback: of the form 'function(err, data) {}'.
 */
function mockServiceMethod(service, client, 
  method, 
  replace) {

  replace = wrapTestStubReplaceFn(replace);

  const service_obj = services[service]
  
  // Service type guard
  if (!service_obj) return;

  const serviceMethodMock = service_obj.methodMocks[method]

  // Service method mock type guard
  if (!serviceMethodMock) return;

  serviceMethodMock.stub = sinon.stub(client, method).callsFake(function () {
    const args = Array.prototype.slice.call(arguments);

    let userArgs
    let userCallback

    if (typeof args[(args.length || 1) - 1] === 'function') {
      userArgs = args.slice(0, -1);
      userCallback = args[(args.length || 1) - 1];
    } else {
      userArgs = args;
    }

    const havePromises = typeof AWS.Promise === 'function';

    let promise 
    let resolve
    let reject
    let storedResult

    const tryResolveFromStored = function() {
      if (storedResult && promise) {
        if (typeof storedResult.then === 'function') {
          storedResult.then(resolve, reject)
        } else if (storedResult.reject) {
          reject(storedResult.reject);
        } else {
          resolve(storedResult.resolve);
        }
      }
    };

    const callback = function(err, data) {
      if (!storedResult) {
        if (err) {
          storedResult = {reject: err};
        } else {
          storedResult = {resolve: data};
        }
      }
      if (userCallback) {
        userCallback(err, data);
      }
      tryResolveFromStored();
    };
    
    const request = {
      promise: havePromises ? function() {
        if (!promise) {
          // @ts-ignore
          promise = new AWS.Promise(function (resolve_, reject_) {
            resolve = resolve_;
            reject = reject_;
          });
        }
        tryResolveFromStored();
        return promise;
      } : undefined,
      createReadStream: function() {
        if (storedResult instanceof Readable) {
          return storedResult;
        }
        if (replace instanceof Readable) {
          return replace;
        } else {
          const stream = new Readable();
          stream._read = function () {
            if (typeof replace === 'string' || Buffer.isBuffer(replace)) {
              this.push(replace);
            }
            this.push(null);
          };
          return stream;
        }
      },
      on: function(eventName, callback) {
        return this;
      },
      send: function(callback) {
        callback(storedResult.reject, storedResult.resolve);
      },
      abort: function(){}
    };

    // different locations for the paramValidation property
    const _client = client
    const config = (_client.config || _client.options || _AWS.config);
    if (config.paramValidation) {
      try {
        // different strategies to find method, depending on whether the service is nested/unnested
        const inputRules =
          ((_client.api && _client.api.operations[method]) || _client[method] || {}).input;
        if (inputRules) {
          const params = userArgs[(userArgs.length || 1) - 1];
          // @ts-ignore
          new _AWS.ParamValidator((_client.config || _AWS.config).paramValidation).validate(inputRules, params);
        }
      } catch (e) {
        callback(e, null);
        return request;
      }
    }

    // If the value of 'replace' is a function we call it with the arguments.
    if (typeof replace === 'function') {
      const concatUserArgs = userArgs.concat([callback])
      const result = replace.apply(replace, concatUserArgs);
      if (storedResult === undefined && result != null &&
          (typeof result.then === 'function' || result instanceof Readable)) {
        storedResult = result
      }
    }
    // Else we call the callback with the value of 'replace'.
    else {
      callback(null, replace);
    }
    return request;
  });
}

/**
 * Restores the mocks for just one method on a service, the entire service, or all mocks.
 *
 * When no parameters are passed, everything will be reset.
 * When only the service is passed, that specific service will be reset.
 * When a service and method are passed, only that method will be reset.
 */
AWS.restore = function(service, method) {
  if (!service) {
    restoreAllServices();
  } else {
    if (method) {
      restoreMethod(service, method);
    } else {
      restoreService(service);
    }
  };
};

/**
 * Restores all mocked service and their corresponding methods.
 */
function restoreAllServices() {
  for (let serviceKey in services) {
    const service = serviceKey;
    restoreService(service);
  }
}

/**
 * Restores a single mocked service and its corresponding methods.
 */
function restoreService(service) {
  if (services[service]) {
    restoreAllMethods(service);

    const serviceObj = services[service];
    if (serviceObj) {
      const stubFun = services[service]?.stub;
      if (stubFun) {
        stubFun.restore();
      }
    }

    delete services[service];
  } else {
    console.log("Service " + service + " was never instantiated yet you try to restore it.");
  }
}
/**
 * Restores all mocked methods on a service.
 */
function restoreAllMethods(service) {
  for (const method in services[service]?.methodMocks) {
    const methodName = method;
    restoreMethod(service, methodName);
  }
}

/**
 * Restores a single mocked method on a service.
 */
function restoreMethod(service, method) {
  const methodName = method
  const serviceObj = services[service]

  // Service type guard
  if(!serviceObj) {
    console.log("Method " + service + " was never instantiated yet you try to restore it.");
    return
  }

  const serviceMethodMock = serviceObj.methodMocks[methodName]

  // Service method mock type guard
  if(!serviceMethodMock) return

  // restore this method on all clients
  const serviceClients = services[service]?.clients;
  if (serviceClients) {
    // Iterate over each client and get the mocked method and restore it
    serviceClients.forEach((client) => {
      const mockedClientMethod = client[methodName];
      if (mockedClientMethod && typeof mockedClientMethod.restore === "function") {
        mockedClientMethod.restore();
      }
    });
  }
  delete services[service]?.methodMocks[methodName];
}

(function() {
  const setPromisesDependency = _AWS.config.setPromisesDependency;
  /* istanbul ignore next */
  /* only to support for older versions of aws-sdk */
  if (typeof setPromisesDependency === 'function') {
    AWS.Promise = global.Promise;
    _AWS.config.setPromisesDependency = function(p) {
      AWS.Promise = p;
      return setPromisesDependency(p);
    };
  }
})();

module.exports = AWS;
