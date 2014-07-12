var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var onHeaders = require('on-headers');

var uglifyjs = require('uglify-js');
var cssmin = require('cssmin');
var sass;
var less;
var stylus;
var coffee;

var memCache = {};

var TYPE_TEXT = 0;
var TYPE_JS = 1;
var TYPE_CSS = 2;
var TYPE_SASS = 3;
var TYPE_LESS = 4;
var TYPE_STYLUS = 5;
var TYPE_COFFEE = 6;

function precompileError(err, type) {
    return JSON.stringify(err);
}

function minifyIt(type, options, content, callback) {
    if (typeof callback != 'function') {
        return;
    }

    switch(type) {
        case TYPE_JS:
            var opt = {fromString: true};
            if (options.no_mangle) {
                opt.mangle = false;
            }
            var result = content;
            try {
                result = uglifyjs.minify(content, opt).code
            } catch(err) {
            }
            callback(result);
            break;
        case TYPE_CSS:
            var result = content;
            try {
                result = cssmin(content)
            } catch(err) {
            }
            callback(result);
            break;
        case TYPE_SASS:
            if (!sass) {
                sass = require('node-sass');
            }
            var result;
            try {
                result = sass.renderSync(content);
                try {
                    result = cssmin(result);
                } catch(err) {
                }
            } catch(err) {
                result = precompileError(err, type);
            }
            callback(result);
            break;
        case TYPE_LESS:
            if (!less) {
                less = new require('less').Parser();
            }
            less.parse(content, function(err, tree) {
                if (err) {
                    callback(precompileError(err, type));
                    return;
                }
                var result = tree.toCSS();
                try {
                    result = cssmin(result);
                } catch(err) {
                }
                callback(result);
            });
            break;
        case TYPE_STYLUS:
            if (!stylus) {
                stylus = require('stylus');
            }
            stylus.render(content, function(err, css) {
                if (err) {
                    callback(precompileError(err, type));
                    return;
                }
                var result = css;
                try {
                    result = cssmin(result);
                } catch(err) {
                }
                callback(result);
            });
            break;
        case TYPE_COFFEE:
            if (!coffee) {
                coffee = require('coffee-script');
            }
            var result;
            try {
                result = coffee.compile(content);
                var opt = {fromString: true};
                if (options.no_mangle) {
                    opt.mangle = false;
                }
                try {
                    result = uglifyjs.minify(result, opt).code
                } catch(err) {
                }
            } catch(err) {
                result = precompileError(err, type);
            }
            callback(result);
            break;
        default:
            callback(content);
            break;
    }
}

function cacheGetFile(hash, callback) {
    if (typeof callback != 'function') {
        return;
    }

    var filepath = this.toString();

    fs.readFile(filepath + hash, { encoding: 'utf8' }, function(err, data) {
        if (err) {
            callback(err);
            return;
        }
        try {
            data = JSON.parse(data).content;
            callback(null, data);
        } catch(err) {
            callback(err);
        }
    });
}

function cachePutFile(hash, minized, callback) {
    var filepath = this.toString();

    // fix issue #3
    // not ended file writing will cause wrong responding.
    // using temp files can mostly avoid the case.

    fs.writeFile(filepath + hash + '.tmp', JSON.stringify({content:minized}), { encoding: 'utf8' }, function(err) {
        if (err) {
            return callback(err);
        }
        fs.rename(filepath + hash + '.tmp', filepath + hash, callback);
    });
}

function cacheGetMem(hash, callback) {
    if (typeof callback != 'function') {
        return;
    }

    if (typeof memCache[hash] == 'undefined') {
        callback(new Error('miss'));
    } else {
        callback(null, memCache[hash]);
    }
}

function cachePutMem(hash, minized, callback) {
    memCache[hash] = minized;

    if (typeof callback == 'function') {
        callback(null);
    }
}

module.exports = function express_minify(options) {
    options = options || {};
    
    var js_match = options.js_match || /javascript/;
    var css_match = options.css_match || /css/;
    var sass_match = options.sass_match || /scss/;
    var less_match = options.less_match || /less/;
    var stylus_match = options.stylus_match || /stylus/;
    var coffee_match = options.coffee_match || /coffeescript/;
    var cache = options.cache || false;

    var cache_get = cacheGetMem;
    var cache_put = cachePutMem;

    if (cache) {
        cache = path.normalize(cache + '/').toString();

        fs.writeFile(cache + 'test.tmp', new Date().getTime().toString(), function(err) {
            if (err) {
                console.log('WARNING: express-minify cache directory is not valid or is not writeable.');
                return;
            }

            //Consider deleting the test file?

            //OK: rewrite functions
            cache_get = function() {
                return cacheGetFile.apply(cache, arguments);
            };
            cache_put = function() {
                return cachePutFile.apply(cache, arguments);
            };
        });
    }
    
    return function minify(req, res, next) {
        var _storeHeader = res._storeHeader;

        var write = res.write;
        var end = res.end;

        var buf = null;
        var type = TYPE_TEXT;

        onHeaders(res, function() {
            if (req.method === 'HEAD') {
                return;
            }

            if (res._no_minify) {
                return;
            }

            var contentType = res.getHeader('Content-Type');
            if (contentType === undefined) {
                return;
            }

            if (sass_match.test(contentType)) {
                type = TYPE_SASS;
                res.setHeader('Content-Type', 'text/css');
            } else if (less_match.test(contentType)) {
                type = TYPE_LESS;
                res.setHeader('Content-Type', 'text/css');
            } else if (stylus_match.test(contentType)) {
                type = TYPE_STYLUS;
                res.setHeader('Content-Type', 'text/css');
            } else if (coffee_match.test(contentType)) {
                type = TYPE_COFFEE;
                res.setHeader('Content-Type', 'text/javascript');
            } else if (js_match.test(contentType)) {
                type = TYPE_JS;
            } else if (css_match.test(contentType)) {
                type = TYPE_CSS;
            }

            if (type === TYPE_TEXT) {
                return;
            }

            res.removeHeader('Content-Length');
            
            // prepare the buffer
            buf = [];
        });

        res.write = function(chunk, encoding) {
            if (!this._header) {
                this._implicitHeader();
            }

            if (buf === null || this._no_minify) {
                return write.call(this, chunk, encoding);
            }

            if (!this._hasBody) {
                return true;
            }

            if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
                throw new TypeError('first argument must be a string or Buffer');
            }

            if (chunk.length === 0) return true;

            // no chunked_encoding here
            if (typeof chunk == 'string') {
                chunk = new Buffer(chunk, encoding);
            }
            
            buf.push(chunk);
        }

        res.end = function(data, encoding) {
            if (this.finished) {
                return false;
            }

            if (!this._header) {
                this._implicitHeader();
            }

            if (data && !this._hasBody) {
                data = false;
            }

            if (buf === null || this._no_minify) {
                return end.call(this, data, encoding);
            }

            // TODO: implement hot-path optimization
            if (data) {
                this.write(data, encoding);
            }

            var buffer = Buffer.concat(buf);

            var sha1 = crypto.createHash('sha1').update(buffer).digest('hex').toString();
            var _this = this;

            cache_get(sha1, function(err, minized) {
                if (err) {
                    switch(type) {
                        case TYPE_TEXT:
                            // impossible to reach here
                            throw new Error('[express-minify] impossible to reach here. Please report the bug.');
                            break;
                        default:
                            // cache miss
                            minifyIt(type, { no_mangle: _this._no_mangle }, buffer.toString(encoding), function(minized) {
                                if (_this._no_cache) {
                                    // do not save cache for this response
                                    write.call(_this, minized, 'utf8');
                                    end.call(_this);
                                } else {
                                    cache_put(sha1, minized, function() {
                                        write.call(_this, minized, 'utf8');
                                        end.call(_this);
                                    });
                                }
                            });
                            break;
                    }
                } else {
                    write.call(_this, minized, 'utf8');
                    end.call(_this);
                }
            });
        }

        next();
    }
};