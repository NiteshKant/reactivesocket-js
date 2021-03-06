'use strict';

var util = require('util');

var EventEmitter = require('events');

var _ = require('lodash');
var assert = require('assert-plus');
var bunyan = require('bunyan');

var CONSTANTS = require('../protocol/constants');
var ERROR_CODES = CONSTANTS.ERROR_CODES;
var FLAGS = CONSTANTS.FLAGS;
var LOG = require('../logger');
var TYPES = CONSTANTS.TYPES;

/**
 * A Reactive Socket Stream. Interactions that originate locally will be
 * invoked from here. Interactions that originate remotely will emit from the
 * Connection object.
 * @param {Object} opts -
 * @param {Object} opts.connection The RS Connection.
 * @param {Object} [opts.log=bunyan] The Bunyan logger.
 * @param {number} opts.id The id of this stream.
 * @constructor
 *
 * @emits response When a response is received by this stream
 * @emits setup-error When an error is received by this stream
 * @emits connection-error When an error is received by this stream
 * @emits application-error When an error is received by this stream
 * @emits rejected-error When an error is received by this stream
 * @emits cancelled-error When an error is received by this stream
 * @emits invalid-error When an error is received by this stream
 * @emits reserved-error When an error is received by this stream
 * @emits error When an error is received by this stream
 */
function RSStream(opts) {
    EventEmitter.call(this);
    assert.object(opts, 'opts');
    assert.object(opts.connection, 'opts.connection');
    assert.optionalObject(opts.log, 'opts.log');
    assert.number(opts.id, 'opts.id');

    this._connection = opts.connection;
    this._id = opts.id;
    this._log = null;

    this._data = {
        response: {},
        responseN: {},
        request: {},
        error: {}
    };

    if (opts.log) {
        this._log = opts.log.child({
            component: 'rs-stream',
            level: process.env.LOG_LEVEL || bunyan.WARN
        });
    } else {
        this._log = LOG;
    }
}
util.inherits(RSStream, EventEmitter);

module.exports = RSStream;


/// API


/**
 * Send a response frame.
 * @param {Object} res The response object.
 * @param {String} [res.data=null] The data string.
 * @param {String} [res.metaData=null] The metaData string.
 *
 * @returns {null}
 */
RSStream.prototype.response = function response(res) {
    var self = this;
    self._log.debug({res: res}, 'Stream.response: entering');

    var frame = {
        type: TYPES.RESPONSE,
        flags: res.follows ? FLAGS.FOLLOWS : FLAGS.NONE,
        data: res.data,
        metadata: res.metadata,
        streamId: self._id
    };
    self._connection.send(frame);
};

/**
 * Send an error frame
 * @param {Object} err The error object.
 * @param {Code} err.code The error code.
 * @param {String} [err.metadata=null] The metadata.
 * @param {String} [err.data=null] The data.
 *
 * @returns {null}
 */
RSStream.prototype.error = function error(err) {
    var self = this;
    self._log.debug({frame: err}, 'Stream.error: entering');

    var frame = {
        type: TYPES.ERROR,
        errorCode: err.errorCode,
        metadata: err.metadata,
        data: err.data,
        streamId: self._id
    };

    self._connection.send(frame);
};

/**
 * @returns {Object} The request object from this stream.
 */
RSStream.prototype.getRequest = function getRequest() {
    var self = this;
    return self._data.request;
};

/**
 * @returns {Object} The latest response object from this stream.
 */
RSStream.prototype.getResponse = function getResponse() {
    var self = this;
    return self._data.response;
};

/**
 * @returns {Object} the latest error object from this stream.
 */
RSStream.prototype.getError = function getError() {
    var self = this;
    return self._data.error;
};


/// Protected


/**
 * Set the inbound response frame for this stream.
 * @param {Object} frame The response frame
 *
 * @returns {null}
 */
RSStream.prototype.setResponse = function setResponse(frame) {
    var self = this;
    var response = self._data.response;

    if (!response) {
        response = {};
    }

    if (response.data) {
        response.data += frame.data;
    } else {
        response.data = frame.data;
    }

    if (response.metadata) {
        response.metadata += frame.metadata;
    } else {
        response.metadata = frame.metadata;
    }

    if (frame.header.flags & FLAGS.FOLLOWS) {
        self._log.debug({frame: frame},
                        'Stream.setResponse: got only partial frame');
        response.follows = true;
    } else {
        //TODO: Send error and close connection when we don't receive a
        // complete flag
        // if we get a response, it means we sent a request -- emit the event
        // on the request EventEmitter.
        self.emit('response', self);
    }
};

/**
 * Set the inbound request frame for this stream.
 * @param {Object} frame The request frame.
 *
 * @returns {null}
 */
RSStream.prototype.setRequest = function setRequest(frame) {
    var self = this;

    var request = self._data.request;

    if (!request) {
        request = {};
    }

    if (request.data) {
        request.data += frame.data;
    } else {
        request.data = frame.data;
    }

    if (request.metadata) {
        request.metadata += frame.metadata;
    } else {
        request.metadata = frame.metadata;
    }

    if (frame.header.flags & FLAGS.FOLLOWS) {
        self._log.debug({frame: frame},
                        'Stream.setRequest: got only partial frame');
        request.follows = true;
    } else {
        // connection EventEmitter because an inbound reqres means we have to
        // handle it programatically from the connection.
        self._connection.emit('request', self);
    }
};

/**
 * Set the inbound error frame for this stream.
 * @param {Object} frame The error frame.
 *
 * @returns {null}
 */
RSStream.prototype.setError = function setError(frame) {
    var self = this;

    var error = _.pick(frame, 'errorCode', 'metadata', 'data');
    self._data.error = error;

    // TODO: formalize and first class errors as Error() objects
    switch (frame.errorCode) {
        case ERROR_CODES.INVALID_SETUP:
        case ERROR_CODES.UNSUPPORTED_SETUP:
        case ERROR_CODES.REJECTED_SETUP:
            // Setup errors are scoped to the connection, so we just emit off
            // the connection error emitter
            if (self._connection.listenerCount('setup-error') === 0) {
                self._connection.emit('error', error);
            }
            self._connection.emit('setup-error', error);
            self.emit('setup-error', error);
            break;
        case ERROR_CODES.CONNECTION_ERROR:
            // Connection errors are global to the stream, so we just emit off
            // the global error emitter
            if (self._connection.listenerCount('connection-error') === 0) {
                self._connection.emit('error', error);
            }
            self._connection.emit('connection-error', error);
            self.emit('connection-error', error);
            break;
        case ERROR_CODES.APPLICATION_ERROR:
            self.emit('application-error', error);
            break;
        case ERROR_CODES.REJECTED:
            self.emit('rejected-error', error);
            break;
        case ERROR_CODES.CANCELED:
            self.emit('cancelled-error', error);
            break;
        case ERROR_CODES.INVALID:
            self.emit('invalid-error', error);
            break;
        case ERROR_CODES.RESERVED:
            self.emit('reserved-error', error);
            break;
        default:
            self.emit('error', error);
            break;
    }
};

/**
 * @returns {Number} returns the ID of this stream
 */
RSStream.prototype.getId = function getId() {
    var self = this;
    return self._id;
};
