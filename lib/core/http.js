'use strict'

/**
 * wrap for request & response
 * @type {Object}
 */
var querystring = require('querystring');
var url = require('url');
var EventEmitter = require('events').EventEmitter;
var os = require('os');
var path = require('path');
var fs = require('fs');

var cookie = think.require('cookie');
var multiparty = require('multiparty');
var mime = require('mime');


module.exports = think.Class({
  /**
   * init method
   * @param  {Object} req [request]
   * @param  {Object} res [response]
   * @return {}     []
   */
  init: function(req, res){
    //request object
    this.req = req;
    //response object
    this.res = res;
    //instance of EventEmitter
    this.http = new EventEmitter();
    //set req & res to http
    this.http.req = req;
    this.http.res = res;
    //http start time
    this.http.startTime = Date.now();
  },
  /**
   * exec
   * @return Promise            []
   */
  run: function(){
    this.bind();
    //array indexOf is faster then string
    var methods = ['POST', 'PUT', 'PATCH'];
    if (methods.indexOf(this.req.method) > -1) {
      return this.getPostData();
    }
    return Promise.resolve(this.http);
  },
  /**
   * check request has post data
   * @return {Boolean} []
   */
  hasPostData: function(){
    if ('transfer-encoding' in this.req.headers) {
      return true;
    }
    var contentLength = this.req.headers['content-length'] | 0;
    return contentLength > 0;
  },
  /**
   * get form file post
   * @return {Promise} []
   */
  getFormFilePost: function(){
    var deferred = Promise.defer();
    var self = this;
    var uploadDir = think.config('post.file_upload_path');
    if (uploadDir) {
      think.mkdir(uploadDir);
    }
    var form = this.form = new multiparty.Form({
      maxFieldsSize: think.config('post.max_fields_size'),
      maxFields: think.config('post.max_fields'),
      maxFilesSize: think.config('post.max_file_size'),
      uploadDir: uploadDir
    });
    form.on('file', function(name, value){
      self.http._file[name] = value;
    });
    form.on('field', function(name, value){
      self.http._post[name] = value;
    });
    form.on('close', function(){
      deferred.resolve(self.http);
    });
    form.on('error', function(err){
      self.res.statusCode = 413;
      self.res.end();
    });
    form.parse(this.req);
    return deferred.promise;
  },
  /**
   * common filed post
   * @return {Promise} []
   */
  getCommonPost: function(){
    var buffers = [];
    var self = this;
    var deferred = Promise.defer();
    this.req.on('data', function(chunk){
      buffers.push(chunk);
    });
    this.req.on('end', function(){
      self.http.payload = Buffer.concat(buffers).toString();
      self.parseFormData().then(function(){
        deferred.resolve(self.http);
      })
    })
    this.req.on('error', function(){
      self.res.statusCode = 413;
      self.res.end();
    })
    return deferred.promise;
  },
  /**
   * parse form data
   * @return {Promise} []
   */
  parseFormData: function(){
    var self = this;
    return think.hook('form_parse', this.http).then(function(){
      if (think.isEmpty(self.http._post) && self.http.payload) {
        try{
          self.http._post = querystring.parse(self.http.payload);
        }catch(e){
          self.res.statusCode = 413;
          self.res.end();
          return Promise.defer().promise;
        }
      }
      var post = self.http._post;
      var length = Object.keys(post).length;
      if (length > think.config('post.max_fields')) {
        self.res.statusCode = 413;
        self.res.end();
        return Promise.defer().promise;
      }
      var maxFilesSize = think.config('post.max_fields_size');
      for(var name in post){
        if (post[name].length > maxFilesSize) {
          self.res.statusCode = 413;
          self.res.end();
          return Promise.defer().promise;
        }
      }
    })
  },
  /**
   * 通过ajax上传文件
   * @return {[type]} [description]
   */
  getAjaxFilePost: function(){
    var self = this;
    var filename = this.req.headers[think.config('post.ajax_filename_header')];
    var deferred = Promise.defer();
    var filepath = think.config('post.file_upload_path') || (os.tmpdir() + '/thinkjs_upload');
    think.mkdir(filepath);
    var name = think.uuid(20);
    filepath += '/' + name + path.extname(filename).slice(0, 5);
    var stream = fs.createWriteStream(filepath);
    this.req.pipe(stream);
    stream.on('error', function(err){
      self.res.statusCode = 413;
      self.res.end();
    })
    stream.on('close', function(){
      self.http._file.file = {
        fieldName: 'file',
        originalFilename: filename,
        path: filepath,
        size: fs.statSync(filepath).size
      }
      deferred.resolve(self.http);
    })
    return deferred.promise;
  },
  /**
   * get post data from request
   * @return {Promise} []
   */
  getPostData: function(){
    if (!this.hasPostData()) {
      return Promise.resolve(this.http);
    }
    var multiReg = /^multipart\/(form-data|related);\s*boundary=(?:"([^"]+)"|([^;]+))$/i;
    //file upload by form or FormData
    if (multiReg.test(this.req.headers['content-type'])) {
      return this.getFilePost();
    }
    //file upload by ajax
    else if(this.req.headers[think.config('post.ajax_filename_header')]){
      return this.getAjaxFilePost();
    }
    return this.getCommonPost();
  },
  /**
   * bind props & methods to http
   * @return {} []
   */
  bind: function(){
    var http = this.http;
    http.url = this.req.url;
    http.version = this.req.httpVersion;
    http.method = this.req.method;
    http.headers = this.req.headers;

    var urlInfo = url.parse('//' + http.headers.host + this.req.url, true, true);
    http.pathname = path.normalize(urlInfo.pathname).slice(1);
    http.query = urlInfo.query;
    http.host = urlInfo.host;
    http.hostname = urlInfo.hostname;

    http._file = {};
    http._post = {};
    http._cookie = cookie.parse(http.headers.cookie);
    http._sendCookie = {};
    http._get = think.extend({}, urlInfo.query);
    http._type = (http.headers['content-type'] || '').split(';')[0].trim();

    http.config = this.config;
    http.referer = this.referer;
    http.isAjax = this.isAjax;
    http.isJsonp = this.isJsonp;
    http.get = this.get;
    http.post = this.post;
    http.param = this.param;
    http.file = this.file;
    http.header = this.header;
    http.ip = this.ip;
    http.cookie = this.cookie;
    http.sendCookie = this.sendCookie;
    http.redirect = this.redirect;
    http.echo = this.echo;
    http.end = this.end;
    http._end = this._end;
    http.sendTime = this.sendTime;
    http.type = this.type;
    http.success = this.success;
    http.fail = this.fail;
    http.jsonp = this.jsonp;
    http.json = this.json;
  },
  /*
   * get or set config
   * @param  {string} name  [config name]
   * @param  {mixed} value [config value]
   * @return {mixed}       []
   */
  config: function(name, value){
    return think.config(name, value, this._config);
  },
  /**
   * get or set content type
   * @param  {String} ext [file ext]
   * @return {}     []
   */
  type: function(contentType, encoding){
    if (!contentType) {
      return this._type;
    }
    if (this._contentTypeIsSend) {
      return;
    }
    if (contentType.indexOf('/') === -1) {
      contentType = mime.lookup(contentType);
    }
    if (contentType.toLowerCase().indexOf('charset=') === -1) {
      contentType += '; charset=' + (encoding || this.config('encoding'));
    }
    this.header('Content-Type', contentType);
  },
  /**
   * get page request referer
   * @param  {String} host [only get referer host]
   * @return {String}      []
   */
  referer: function(host){
    var referer = this.headers.referer || this.headers.referrer || '';
    if (!referer || !host) {
      return referer;
    }
    var info = url.parse(referer);
    return info.hostname;
  },
  /**
   * is ajax request
   * @param  {String}  method []
   * @return {Boolean}        []
   */
  isAjax: function(method) {
    if (method && this.method !== method.toUpperCase()) {
      return false;
    }
    return this.headers['x-requested-with'] === 'XMLHttpRequest';
  },
  /**
   * is jsonp request
   * @param  {String}  name [callback name]
   * @return {Boolean}      []
   */
  isJsonp: function(name){
    name = name || this.config('callback_name');
    return !!this.get(name);
  },
  /**
   * get or set get params
   * @param  {String} name []
   * @return {Object | String}      []
   */
  get: function(name, value){
    if (value === undefined) {
      if (name === undefined) {
        return this._get;
      }else if (think.isString(name)) {
        return this._get[name] || '';
      }
      this._get = name;
    }else{
      this._get[name] = value;
    }
  },
  /**
   * get or set post params
   * @param  {String} name []
   * @return {Object | String}      []
   */
  post: function(name, value){
    if (value === undefined) {
      if (name === undefined) {
        return this._post;
      }else if (think.isString(name)) {
        return this._post[name] || '';
      }
      this._post = name;
    }else {
      this._post[name] = value;
    }
  },
  /**
   * get post or get params
   * @param  {String} name []
   * @return {Object | String}      []
   */
  param: function(name){
    if (name === undefined) {
      return think.extend({}, this._get, this._post);
    }
    return this._post[name] || this._get[name] || '';
  },
  /**
   * get or set file data
   * @param  {String} name []
   * @return {Object}      []
   */
  file: function(name, value){
    if (value === undefined) {
      if (name === undefined) {
        return this._file;
      }
      return this._file[name] || {};
    }
    this._file[name] = value;
  },
  /**
   * get or set header
   * @param  {String} name  [header name]
   * @param  {String} value [header value]
   * @return {}       []
   */
  header: function(name, value){
    if (name === undefined) {
      return this.headers;
    }else if (value === undefined) {
      return this.headers[name] || '';
    }
    //set header
    if (!this.res.headersSent) {
      //check content type is send
      if (name === 'Content-Type') {
        if (this._contentTypeIsSend) {
          return;
        }
        this._contentTypeIsSend = true;
      }
      this.res.setHeader(name, value);
    }
  },
  /**
   * get uesr ip
   * @return {String} [ip4 or ip6]
   */
  ip: function(){
    var connection = this.req.connection;
    var socket = this.req.socket;
    if (connection && connection.remoteAddress !== localIp) {
      return connection.remoteAddress;
    }else if (socket && socket.remoteAddress !== localIp) {
      return socket.remoteAddress;
    }
    return this.headers['x-forwarded-for'] || this.headers['x-real-ip'] || think.localIp;
  },
  /**
   * get or set cookie
   * @param  {} name    [description]
   * @param  {[type]} value   [description]
   * @param  {[type]} options [description]
   * @return {[type]}         [description]
   */
  cookie: function(name, value, options){
    //send cookies
    if (name === true) {
      if (think.isEmpty(this._sendCookie)) {
        return;
      }
      var cookies = Object.values(this._sendCookie).map(function(item){
        return cookie.stringify(item.name, item.value, item);
      });
      this.header('Set-Cookie', cookies);
      this._sendCookie = {};
      return;
    }else if (name === undefined) {
      return this._cookie;
    }else if (value === undefined) {
      return this._cookie[name] || '';
    }
    //set cookie
    if (typeof options === 'number') {
      options = {timeout: options};
    }
    options = think.extend({}, this.config('cookie'), options);
    if (value === null) {
      options.timeout = -1000;
    }
    if (options.timeout !== 0) {
      options.expires = new Date (Date.now() + options.timeout * 1000);
    }
    options.name = name;
    options.value = value;
    this._sendCookie[name] = options;
  },
  /**
   * redirect
   * @param  {String} url  [redirect url]
   * @param  {Number} code []
   * @return {}      []
   */
  redirect: function(url, code){
    this.res.statusCode = code || 302;
    this.header('Location', url || '/');
    this.end();
  },
  /**
   * send time
   * @param  {String} name [time type]
   * @return {}      []
   */
  sendTime: function(name){
    var time = Date.now() - this.startTime;
    this.header('X-' + (name || 'EXEC-TIME'), time + 'ms');
  },
  /**
   * output with success errno & errmsg
   * @param  {Object} data    [output data]
   * @param  {String} message [errmsg]
   * @return {Promise}         [pedding promise]
   */
  success: function(data, message){
    var key = [this.config('error.key'), this.config('error.msg')];
    var obj = think.getObject(key, [0, message || '']);
    if (data !== undefined) {
      obj.data = data;
    }
    this.type(this.config('json_content_type'));
    this.end(obj);
  },
  /**
   * output with fail errno & errmsg
   * @param  {Number} errno  [error number]
   * @param  {String} errmsg [error message]
   * @param  {Object} data   [output data]
   * @return {Promise}        [pedding promise]
   */
  fail: function(errno, errmsg, data){
    var obj;
    if (think.isObject(errno)) {
      data = errmsg;
      obj = think.extend({}, errno);
    }else{
      if (!think.isNumber(errno)) {
        data = errmsg;
        errmsg = errno;
        errno = this.config('error.value');
      }
      var key = [this.config('error.key'), this.config('error.msg')];
      var value = [errno, errmsg || 'error'];
      obj = think.getObject(key, value);
    }
    if (data !== undefined) {
      obj.data = data;
    }
    this.type(this.config('json_content_type'));
    this.end(obj);
  },
  /**
   * output with jsonp
   * @param  {Object} data [output data]
   * @return {}      []
   */
  jsonp: function(data) {
    this.type(this.config('json_content_type'));
    var callback = this.get(this.config('callback_name'));
    //remove unsafe chars
    callback = callback.replace(/[^\w\.]/g, '');
    if (callback) {
      data = callback + '(' + (data !== undefined ? JSON.stringify(data) : '') + ')';
    } 
    this.end(data);
  },
  /**
   * output with json
   * @param  {Object} data [output data]
   * @return {Promise}      []
   */
  json: function(data){
    this.type(this.config('json_content_type'));
    this.end(data);
  },
  /**
   * echo content
   * @param  {mixed} obj      []
   * @param  {String} encoding []
   * @return {Promise}          []
   */
  echo: function(obj, encoding){
    this.type(this.config('tpl.content_type'));
    this.cookie(true);
    this.sendTime();
    if (obj === undefined) {
      return;
    }
    if (think.isArray(obj) || think.isObject(obj)) {
      obj = JSON.stringify(obj);
    }else if (!think.isBuffer(obj)) {
      obj += '';
    }
    encoding = encoding || this.config('encoding');
    var outputConfig = this.config('output_content');
    if (!outputConfig) {
      return this.res.write(obj, encoding);
    }
    if (!think.isFunction(outputConfig)) {
      outputConfig = global[outputConfig];
    }
    if (!this._outputContentPromise) {
      this._outputContentPromise = [];
    }
    var fn = think.co.wrap(outputConfig);
    var promise = fn(obj, encoding, this);
    this._outputContentPromise.push(promise);
  },
  _end: function(){
    this.cookie(true);
    this.sendTime();
    this.res.end();
    this.emit('afterEnd', this);

    //remove upload tmp files
    if (!think.isEmpty(this._file)) {
      var key, filepath;
      for(key in this._file){
        filepath = this._file[key].path;
        if (think.isFile(filepath)) {
          fs.unlink(filepath, function(){});
        }
      }
    }
  },
  /**
   * http end
   * @return {} []
   */
  end: function(obj, encoding){
    this.echo(obj, encoding);
    //set http end flag
    this._isEnd = true;
    if (!this._outputContentPromise) {
      this._end();
    }
    var self = this;
    Promise.all(this._outputContentPromise).then(function(){
      this._outputContentPromise = undefined;
      self._end();
    }).catch(function(err){
      self._end();
    })
  }
}, true);