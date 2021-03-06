/* 
DO NOT HASH BANG THIS APP!

Node-RRBench (Request Response Bench) aka Hammer

author: Jason Giedymin --<jasong>_at_<apache>dot<org>--

*/

(function() {
// Purposely not AMD nor require framed, but raw script
// exports ready, none defined

var events = require('events'),
    util = require('util'),
    request = require('request'),
    async = require('async'),
    _ = require('underscore'),
    microtime = require('microtime'),
    ProgressBar = require('progress'),
    program = require('commander'),
    http = require('http');

http.globalAgent.maxSockets = 50000;

/* ------------ Custom Objects and Functions ------------- */
// Setup Eventer
function RequestEventer() {
  events.EventEmitter.call(this);
  this.end = function(data) {
    this.emit('end', data);
  };
};
util.inherits(RequestEventer, events.EventEmitter);

function url(req_obj, event_opt) {
  // Params
  const formatting = {
    delimiters: {
      seperator: '/',
      proto: '://',
      socket: ':'
    }
  };

  const returnVal = {
    method: req_obj.method,
    url: req_obj.scheme + formatting.delimiters.proto + req_obj.host + 
         formatting.delimiters.socket + req_obj.port +
         formatting.delimiters.seperator + req_obj.url,
    pool: {
      maxSockets: event_opt.maxSockets
    },
    headers: {
      "Connection": "Keep-Alive"
    }
    ,timeout: event_opt.timeout
    ,body: JSON.stringify(req_obj.body)
  };

  return returnVal;
};

function simulate(min, max) { // need a better rand distr, maintain this api
  return Math.random() * (max - min) + min;
};

// Not a streaming write
function writeStatsLog(logFn, event_log_file, data) {
  var fs = require('fs'); // Lazy
  fs.writeFile(event_log_file, util.inspect(data), function(err) {
    if(err)
      console.log(err);
    else {
      logFn("Event timing data logged to [%s].", event_log_file); 
    }
  }); 
};

function TimingStat(thread, request_id, start, end, misc) {
  this.thread = thread;
  this.request_id = request_id;
  this.start = start;
  this.end = end;
  this.misc = misc;
  this.toString = function() {return "[object TimingStat]";} // prototype override
};

function generateRequestTask(req_id) {
  return {req_id: req_id};
}

function generateRequestTasks(range) {
  return _.map(range, generateRequestTask);
}

function Hammer(mutants, app_opt, event_opt, req_obj) {
  this.mutants = mutants;
  this.app_opt = app_opt;
  this.event_opt = event_opt;
  this.req_obj = req_obj;

  var eventer = new RequestEventer();
  var request_listener = new RequestListener(eventer);
  request_listener.setConcurrencyLimit(app_opt.concurrency);
  eventer.on('end', request_listener.endHandler);

  // Listener
  function RequestListener() {
    var thread_count = 0;
    var concurrency_limit = 0;

    this.setConcurrencyLimit = function(concurrency_limit) {
      this.concurrency_limit = concurrency_limit;
    };

    this.endHandler =  function() {
      thread_count++;
      log("*Thread 'end' triggered for thread:[%s]...", thread_count);

      if( (thread_count === app_opt.concurrency) || !app_opt.simulate ) {
        log("<- All threads executed.")

        if (app_opt.record_stats)
          writeStatsLog(log, app_opt.event_log_file, mutants.event_log);

        console.log(""); // customary cli buffer flush
      }
    },
    this.startHandler = function(data) {
      log("*Thread 'start' triggered for thread:[%s]...", thread_count);
    }
  };

  function log(/*slurp*/) {
    if (app_opt.debug) {
      var new_args = arguments;
      new_args[0] = "[DEBUG] - ".concat(arguments[0]);
      console.log.apply(this, new_args);
    }
  };

  function logError(/*slurp*/) { // someday
    var new_args = arguments;
    new_args[0] = "[ERROR] - ".concat(arguments[0]);
    console.log.apply(this, new_args);
  }

  function sendRequest(timings, thread, req_id, callback) {
    var curr_timing = new TimingStat(thread, req_id, 0,0,0);
    var request_url = url(req_obj, event_opt); // create to keep request timing accurate
    
    curr_timing.start = microtime.now(); // get time, and send request

    // there is logging overhead but it is very very micro, and is generally constant
    // since node still is single threaded (logger will just be queued).
    log("--> Sending thread:request id:timing => [%s:%s:%s]", thread, req_id, curr_timing.start);

    function requestComplete(error, response, body) {
      if (!error && response.statusCode == 200) {
        if(app_opt.debug)
          log(body)

        mutants.count.pass++;
        curr_timing.end = microtime.now();
        calculateTime(curr_timing);
        timings.push(curr_timing);

        if (app_opt.show_progress)
          tickProgressBar();
        
        callback();
      }
      else {
        mutants.count.fail++;
        logError("%s", error);
      }
    };

    request(request_url, requestComplete);
  };

  function concurrentIterator(thread, callback) {
    var curr_timing = new TimingStat(thread, 0, 0,0,0); // request_id 0 is thread launch time
    
    function concurrent_time() {
      if (app_opt.simulate)
        return simulate(event_opt.simulate.min, event_opt.simulate.max);
      else
        return event_opt.simulate.tick;
    };

    function next() {
      curr_timing.start = microtime.now(); // get time
      mutants.addEvent(curr_timing); // Add thread init timing info now as req 0

      log("-> concurrent launch of thread:[%s]", thread)
      runRequests(thread);

      callback(); // go and launch the next concurrent thread
    }

    setTimeout(next, concurrent_time());
  };

  function requestIterator(timings, thread, requestIndex, callback) {
      setTimeout(function() {
        sendRequest(timings, thread, requestIndex, callback);
      }, event_opt.simulate.tick);
  };

  // sync
  function runRequests(thread) {
    var range = _.range(1, app_opt.requests+1); // no 0 index
    var timings = [];

    async.forEachSeries(range, requestIterator.bind(this, timings, thread), function(err) {
      mutants.addEvent(timings);
      log("<-- requests complete for thread:[%s]", thread);

      eventer.end();
    });
  };

  // async
  function runConcurrent() {
    var range = _.range(1, app_opt.concurrency+1); // no 0 index plz
    createProgressBar();

    async.forEach(range, concurrentIterator.bind(this), function(err){
      log("All concurrent threads launched");
    });
  };

  function createProgressBar() {
    if (app_opt.simulate) {
      this.total = (app_opt.concurrency * app_opt.requests);
      this.info = "[" + app_opt.concurrency + "]x" + app_opt.requests + " Blitz ";
    }
    else {
      this.total = app_opt.queue;
      this.info = "x[" + app_opt.concurrency + "]";
    }
    mutants.progress_bar = new ProgressBar('  ' + program.mode + ' :total=' + info + ' [:bar] :percent +:elapsed/-:etas :avgms/req', { total: this.total, width: 50, avg: 10});
  }

  function tickProgressBar() { // keep this api
    mutants.progress_bar.tick({'avg':(mutants.time.avg/1000).toFixed(2)});
  }

  function runConcurrency() {
    var timings = [];
    var range = _.range(1, app_opt.queue+1);

    if (app_opt.show_progress)
      createProgressBar(mutants, app_opt);

    function next(req_id, callback) {
      sendRequest(timings, '?', req_id, callback);
    }

    function doTask(task, callback) {
      setTimeout(next.bind(this, task.req_id, callback), event_opt.simulate.tick);
    }

    var q = async.queue(doTask, app_opt.concurrency);

    q.empty = function() {
      log("*Queue empty, last task processing...");
    }

    q.drain = function() {
      log("*Queue complete, last task completed.");
      mutants.addEvent(timings);
      eventer.end();
    };

    // add some items to the queue (batch-wise)
    q.push(generateRequestTasks(range), function (err) {
      log("Batch added.")
    });
  }

  function calculateTime(timing_stat) {
    var curr_time = timing_stat.end - timing_stat.start;
    var counts = mutants.count.pass + mutants.count.fail;

    mutants.time.total = mutants.time.total + curr_time;

    if(curr_time < mutants.time.min)
      mutants.time.min = curr_time;

    if(curr_time > mutants.time.max)
      mutants.time.max = curr_time;

    mutants.time.avg = (mutants.time.total / counts);
  }

  this.bang = function() {
    if(app_opt.simulate)
      runConcurrent();
    else
      runConcurrency();
  }
};

/* -------------- main ----------------- */

function commandLine(program, args) {
  program
    .version('0.9.5')
    .usage('-[lvvms] -h --help\n\n' +
      '  Notes:\n' +
      '   Timing is done at a resolution of 1/1,000,000 of a second.\n' +
      '   In [queue] mode, the requests option is ignored.\n' +
      '   In [blitz] mode, the queue option is ignored.\n' +
      '\n' +
      '  Blitz mode simulates the seemingly randomness of requests from the internet.\n' +
      '  Queue mode will send requests pending the next in a queue until a message is received.\n' +
      '\n' +
      '  * All modes are queue backed however queue mode shares a single queue.\n' +
      '    A seperate queue exists for each concurrent request (-k) asked to create in blitz mode.\n' +
      '  * Logging is disabled by default.\n' +
      '\n' +
      '  Example:\n' +
      '    - Queue mode, 8 concurrent request pumps filled with 1000 requests each (8000 total)\n' +
      '      node loadtest.js -m queue -k 8 -q 1000\n' +
      '\n' +
      '  See LICENSE file for license and legal information.\n\n'
    )
    .option('-l, --logging', 'Enables microtiming stats logging to loadtest.log, disabled by default.')
    .option('-v, --verbose', 'Verbosely displays status, disabled by default.')
    .option('-y, --very-verbose', 'Very Verbose. Disabled by default. Warning: will show all available info.') // shout-out to lvm's Heinz M.
    .option('-m, --mode <mode>', 'Use the specified mode [blitz, queue], defaults to queue.', 'queue')
    .option('-s, --server', 'Start server and stream results')
    .option('-k, --concurrency <n>', 'Number of concurrent threads, defaults to 10. Applicable in modes: [blitz, queue].', parseInt)
    .option('-r, --requests <n>', 'Number of requests to send, defaults to 1000. Applicable in modes: [blitz].', parseInt)
    .option('-q, --queue <n>', 'Number of requests to fill queue with, defaults to 1000. Applicable in modes: [queue]', parseInt)
    .parse(args);
};

function main() {
  commandLine(program, process.argv);

  const messages = {
    "app-start": "Microtiming stats being gathered...\nRealtime timing information will not be displayed to prevent overhead taint."
  }

  // Request Obj
  const req_obj = {
    method: "GET",
    scheme: 'http',
    host: 'localhost',
    port: 3000,
    url: "/"
  };

  // App Options Defaults
  var app_opt = {
    debug: false,
    record_stats: false,
    show_progress: true,
    event_log_file: "./loadtest.log",
    concurrency: 10, //threads : async
    requests: 100, //requests : sync
    queue: 1000,
    simulate: false,
    "keep-alive": true
  };

  // Event Timing Options
  const event_opt = {
    timeout: 20000,
    max_errors: 10,
    simulate: {
      max: 2000,
      min: 250,
      tick: 100
    },
    maxSockets: 10000
  };

  // const request_opt = {
  //   timeout: event_opt.timeout,
  //   method: 'GET',
  //   headers: {}
  // };

  // Mutation namespace - all mutations _may_ be done within here
  var mutants = {
    progress_bars: {},
    threads: [],
    count: { // running count
      pass: 0,
      fail: 0
    },
    time: { // running time
      min: 0,
      max: 0,
      avg: 0,
      total: 0
    },
    last: { // last iter
      start: 0,
      end: 0,
      data: ""
    },
    event_log: [],
    addEvent: function(an_event) {
      if ( (an_event) && (an_event.length) && (an_event.length > 1) ) {
        var new_list = this.event_log.concat(an_event);
        this.event_log = new_list;
      }
      else if (an_event) {
        this.event_log.push(an_event);
      }
    },
    pandoras_box: ""// <-- don't touch!
  };

  function setParams(cb) {
    if (program.logging)
      app_opt.record_stats = true;

    if (program.verbose) {
      app_opt.show_progress = false;
      app_opt.debug = true;
    }
    if (program.veryVerbose) {
      app_opt.show_progress = true;
      app_opt.debug = true;
    }

    if (program.concurrency)
      app_opt.concurrency = program.concurrency;
    if (program.requests)
      app_opt.requests = program.requests;
    if (program.queue)
      app_opt.queue = program.queue;

    if (program.mode) {
      switch(program.mode) {
        case "blitz":
          app_opt.simulate = true;
          break;
        case "queue":
          app_opt.simulate = false;
          break;
        default:
          return cb( new Error("Unknown program mode, see '-h or --help' for help.") )
      }
    }

    return cb();
  }

  setParams( function(err) {
    if (err)
      console.log( program.usage() );
    else {
      new Hammer(mutants, app_opt, event_opt, req_obj).bang();
    }
  })
};

main();

//exports.exec = main();
})(); // type safe wrapper