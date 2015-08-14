'use strict';

var _ = require('underscore-contrib');
var questor = require('questor');
var redefine = require('redefine');
var querystring = require('querystring');
var rateLimit = require('./rate-limit');

module.exports = redefine.Class({
  constructor: function Client(options) {
    enforcep(options, 'accessToken');

    this.options = _.defaults({}, options, {
      host: 'api.contentful.com',
      secure: true,
      rateLimit: 6
    });

    // decorate this.request with a rate limiter
    this.request = rateLimit(this.options.rateLimit, 1000, this.request);
  },

  request: function(path, options) {
    if (!options) options = {};
    if (!options.method) options.method = 'GET';
    if (!options.headers) options.headers = {};
    if (!options.query) options.query = {};
    options.headers['Content-Type'] = 'application/vnd.contentful.management.v1+json';
    options.query.access_token = this.options.accessToken;

    var uri = [
      this.options.secure ? 'https' : 'http',
      '://',
      _.first(this.options.host.split(':')),
      ':',
      this.options.host.split(':')[1] || (this.options.secure ? '443' : '80'),
      path,
      '?',
      querystring.stringify(options.query)
    ].join('');

    var self = this;
    return questor(uri, options)
      .then(parseJSONBody)
      .catch(function(error) {
        return 'body' in error;
      }, function(response) {
        // Rate-limited by the server, retry the request
        if (response.status === 429) {
          return self.request(path, options);
        }
        // Otherwise parse, wrap, and rethrow the error
        var error = parseJSONBody(response);
        throw new exports.APIError(error, {
          method: options.method,
          uri: uri,
          body: options.body
        });
      })
      .catch(SyntaxError, function (err) {
        // Attach request info if JSON.parse throws
        err.request = {
          method: options.method,
          uri: uri,
          body: options.body
        };
        throw err;
      });
  },

  createSpace: function(space, organizationId) {
    var headers = {};
    if (organizationId) {
      headers['X-Contentful-Organization'] = organizationId;
    }
    return this.request('/spaces', {
      method: 'POST',
      body: JSON.stringify(space),
      headers: headers
    }).then(_.partial(Space.parse, this));
  },

  getSpace: function(identifiable) {
    var id = getId(identifiable);
    return this.request('/spaces/' + id).then(_.partial(Space.parse, this));
  },

  getSpaces: function() {
    return this.request('/spaces').then(_.partial(SearchResult.parse, this));
  },

  updateSpace: function(space) {
    var id = getId(space);
    var version = getVersion(space);
    return this.request('/spaces/' + id, {
      method: 'PUT',
      headers: {
        'X-Contentful-Version': version
      },
      body: JSON.stringify(getData(space))
    }).then(_.partial(Space.parse, this.client));
  },

  deleteSpace: function(identifiable) {
    var id = getId(identifiable);
    return this.request('/spaces/' + id, {
      method: 'DELETE',
      ignoreResponseBody: true
    });
  }
});

exports.createClient = _.fnull(function(options) {
  return new Client(options);
}, {});

exports.APIError = require('./api-error');

function compacto(object) {
  return _.reduce(object, function(compacted, value, key) {
    if (_.truthy(value)) compacted[key] = value;
    return compacted;
  }, {});
}

function enforcep(object, property) {
  if (!_.exists(object[property]))
    throw new TypeError('Expected property ' + property);
}

var parseableResourceTypes =  {
  Asset: Asset,
  ContentType: ContentType,
  Entry: Entry,
  Space: Space
};

function isParseableResource(object) {
  return _.getPath(object, ['sys', 'type']) in parseableResourceTypes;
}

function parseResource(client) {
  var resource, Type;
  if (arguments.length === 2) {
    resource = arguments[1];
    Type = parseableResourceTypes[resource.sys.type];
    return Type.parse(client, resource);
  } else if (arguments.length === 3) {
    var space = arguments[1];
    resource = arguments[2];
    Type = parseableResourceTypes[resource.sys.type];
    return Type.parse(client, space, resource);
  }
}

function stringifyArrayValues(object) {
  return _.reduce(object, function(object, value, key) {
    object[key] = _.isArray(value) ? value.join(',') : value;
    return object;
  }, {});
}

function walkMutate(input, pred, mutator) {
  if (pred(input))
    return mutator(input);

  if (_.isArray(input) || _.isObject(input)) {
    _.each(input, function(item, key) {
      input[key] = walkMutate(item, pred, mutator);
    });
    return input;
  }

  return input;
}

function parseJSONBody(response) {
  if (!response.body) return;
  return JSON.parse(response.body);
}
