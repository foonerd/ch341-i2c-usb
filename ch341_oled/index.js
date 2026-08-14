'use strict';

/*
  CH341 OLED - Volumio plugin

  Copyright (c) 2026 foonerd
  https://github.com/foonerd/ch341-i2c-usb

  Drives an I2C OLED panel through a WCH CH341A USB adapter using a
  userspace transport. No kernel module, so nothing to rebuild after a
  system update.

  Licence: MIT
*/

var libQ = require('kew');
var fs = require('fs-extra');
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;

var PLUGIN_DIR = '/data/plugins/system_hardware/ch341_oled';
var START_SCRIPT = PLUGIN_DIR + '/start.sh';
var SERVICE = 'ch341_oled';
var FIFO = '/tmp/ch341_oled_fifo';
var BIN = '/usr/local/bin/mpd_oled';

module.exports = ch341Oled;

function ch341Oled (context) {
  var self = this;

  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.context.logger;
  self.configManager = self.context.configManager;
}

// ---------------------------------------------------------------- lifecycle

ch341Oled.prototype.onVolumioStart = function () {
  var self = this;
  var configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, 'config.json');

  self.config = new (require('v-conf'))();
  self.config.loadFile(configFile);

  // Volumio rebuilds asound.conf after every onVolumioStart and before
  // onStart. The static ALSA snippet names this FIFO, so it has to exist
  // here - not in onStart, which is too late on both boot and enable.
  self.ensureFifo();

  return libQ.resolve();
};

ch341Oled.prototype.onStart = function () {
  var self = this;

  self.ensureFifo();

  if (!self.writeStartScript()) {
    self.logger.error('ch341_oled: cannot write start script');
    self.commandRouter.pushToastMessage('error',
      'CH341 OLED', 'Could not write the start script. Check the log.');
    // Still resolve: the ALSA tap is live and the user can reach settings.
    return libQ.resolve();
  }

  // Do not rebuild ALSA here. Core already did that after onVolumioStart
  // (enable and boot). A second rebuild with identical content skips the
  // player reopen, and a fire-and-forget one races the service.
  //
  // Resolve even if the unit fails. A missing or slow adapter must not
  // block enable, or the user cannot reach the settings page.
  return self.startService()
    .fail(function (e) {
      self.logger.error('ch341_oled: failed to start: ' + e);
      self.commandRouter.pushToastMessage('error',
        'CH341 OLED', 'The display did not start. Check the log.');
      return libQ.resolve();
    });
};

/*
  Create the FIFO cava reads, or leave a live one alone.

  Mode 666, not 646. tmpfiles.d owns the pipe volumio:audio. MPD runs as
  mpd and is in group audio, so 646 gives it group read-only and
  pcm.volumio fails with Permission denied. 666 lets whichever playback
  user write; cava still reads as volumio.

  Never replace an existing FIFO. ALSA may already hold the inode after
  the core ALSA rebuild; rm+mkfifo would leave writers on a dead pipe
  and break playback. A leftover regular file from the old ALSA "file"
  plugin is removed and replaced. Mode is always corrected.
*/
ch341Oled.prototype.ensureFifo = function () {
  var self = this;

  try {
    var st = fs.statSync(FIFO);
    if (st.isFIFO()) {
      try {
        fs.chmodSync(FIFO, 0o666);
      } catch (e) {
        self.logger.error('ch341_oled: cannot chmod ' + FIFO + ': ' + e);
      }
      return true;
    }
    self.logger.info('ch341_oled: replacing non-FIFO at ' + FIFO);
    fs.unlinkSync(FIFO);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      self.logger.error('ch341_oled: cannot stat ' + FIFO + ': ' + e);
    }
  }

  try {
    execSync('/usr/bin/mkfifo -m 666 ' + FIFO, { uid: 1000, gid: 1000 });
    self.logger.info('ch341_oled: created ' + FIFO);
    return true;
  } catch (e) {
    try {
      if (fs.statSync(FIFO).isFIFO()) {
        try { fs.chmodSync(FIFO, 0o666); } catch (ignored) {}
        return true;
      }
    } catch (ignored) {}
    self.logger.error('ch341_oled: cannot create ' + FIFO + ': ' + e);
    return false;
  }
};

ch341Oled.prototype.onStop = function () {
  var self = this;

  // Stop and disable the unit so it cannot come back as "active
  // (running)" while the plugin is disabled. Do not rebuild ALSA - core
  // disablePlugin does that after onStop, once enabled is false. Do not
  // remove the FIFO: a mere stop leaves the snippet in asound.conf, and
  // on disable the core rebuild drops the snippet first.
  return self.stopService();
};

ch341Oled.prototype.onRestart = function () {
  var self = this;
  return self.restartService();
};

// ------------------------------------------------------------- command line

/*
  Assemble the mpd_oled argument list from the saved configuration.

  The device string is the interesting part:

    SSD1306,128X64_NONAME,I2C,ch341=0,ch341_speed=2,xoffset=2

  ch341=N selects the adapter and switches libu8g2arm to the userspace
  transport. There is no bus number because no kernel I2C bus exists in
  this configuration.
*/
ch341Oled.prototype.buildArgs = function () {
  var self = this;
  var args = [];

  args.push('-b', String(self.config.get('numberOfBars', 20)));
  args.push('-g', String(self.config.get('gapBetweenBars', 2)));
  args.push('-P', self.config.get('pauseScreenType', 's'));
  args.push('-L', self.config.get('layout', 't'));
  args.push('-f', String(self.config.get('frameRate', 50)));

  // Player status polling interval.
  //
  // On Volumio each poll is an HTTP request to the player API, and the
  // backend logs every call while assembling player state. mpd_oled
  // defaults to 0.3 s, which put six requests per second into the
  // journal continuously. One second is indistinguishable on a display
  // showing elapsed time to the second.
  args.push('-u', String(self.config.get('pollSeconds', 1.0)));

  // Spectrum delay.
  //
  // The ALSA tap feeding cava sits before the audio output buffer, so
  // the bars run ahead of the sound by whatever that buffer holds. The
  // amount depends on the output device, so the default is 0 and the
  // user dials it in.
  var delayMs = self.config.get('spectrumDelayMs', 0);
  if (delayMs > 0) {
    args.push('-D', String(delayMs));
  }

  var o = self.config.get('oledModel', 'SSD1306,128X64_NONAME');
  o += ',I2C';
  o += ',ch341=' + self.config.get('ch341Index', 0);

  var speed = self.config.get('ch341Speed', 2);
  if (speed !== 2) {
    // 2 (400 kHz) is the transport default, so only emit when it differs
    o += ',ch341_speed=' + speed;
  }

  var xoffset = self.config.get('xoffset', 0);
  if (xoffset > 0) {
    o += ',xoffset=' + xoffset;
  }

  var addr = self.config.get('i2cAddress', '');
  if (addr && addr.length) {
    o += ',i2c_address=' + addr;
  }

  if (self.config.get('rotateDisplay', false)) {
    o += ',rotation=2';
  }

  args.push('-o', o);

  if (self.config.get('spectrumEnabled', true)) {
    args.push('-c', 'fifo,' + FIFO);
  }

  return args;
};

/*
  The service runs a generated script rather than a fixed ExecStart, so
  that changing settings needs no root-owned file to be rewritten. The
  script lives in the plugin directory, which is writable by volumio and
  survives a reboot - unlike /tmp.
*/
ch341Oled.prototype.writeStartScript = function () {
  var self = this;
  var args = self.buildArgs();

  var quoted = args.map(function (a) {
    return "'" + String(a).replace(/'/g, "'\\''") + "'";
  }).join(' ');

  var script = '#!/bin/bash\n' +
    '# Generated by the ch341_oled plugin. Edits will be overwritten.\n' +
    'exec ' + BIN + ' ' + quoted + '\n';

  try {
    fs.writeFileSync(START_SCRIPT, script, 'utf8');
    fs.chmodSync(START_SCRIPT, 0o755);
    self.logger.info('ch341_oled: ' + BIN + ' ' + quoted);
    return true;
  } catch (e) {
    self.logger.error('ch341_oled: cannot write start script: ' + e);
    return false;
  }
};

// ---------------------------------------------------------------- service

ch341Oled.prototype.systemctl = function (verb, quiet) {
  var self = this;
  var defer = libQ.defer();

  exec('/usr/bin/sudo /bin/systemctl ' + verb + ' ' + SERVICE + '.service',
    { uid: 1000, gid: 1000 },
    function (error, stdout) {
      if (error) {
        if (!quiet) {
          self.logger.error('ch341_oled: systemctl ' + verb + ' failed: ' + error);
        }
        defer.reject(error);
      } else {
        defer.resolve(stdout);
      }
    });

  return defer.promise;
};

ch341Oled.prototype.startService = function () {
  var self = this;

  // Enable first so systemd loads the unit. reset-failed before that
  // logs "Unit not loaded" on the first enable after install.
  // Type=simple: start returns when the process is spawned, not when
  // the panel is up.
  return self.systemctl('enable')
    .fail(function (e) {
      self.logger.info('ch341_oled: enable skipped: ' + e);
      return libQ.resolve();
    })
    .then(function () {
      return self.systemctl('reset-failed', true)
        .fail(function () { return libQ.resolve(); });
    })
    .then(function () { return self.systemctl('start'); });
};

ch341Oled.prototype.stopService = function () {
  var self = this;

  return self.systemctl('stop')
    .fail(function () { return libQ.resolve(); })
    .then(function () {
      return self.systemctl('disable')
        .fail(function (e) {
          self.logger.info('ch341_oled: disable skipped: ' + e);
          return libQ.resolve();
        });
    });
};

ch341Oled.prototype.restartService = function () {
  var self = this;

  if (!self.writeStartScript()) {
    return libQ.reject(new Error('ch341_oled: cannot write start script'));
  }

  return self.systemctl('reset-failed', true)
    .fail(function () { return libQ.resolve(); })
    .then(function () { return self.systemctl('restart'); });
};

// ------------------------------------------------------------------- UI

ch341Oled.prototype.getUIConfig = function () {
  var self = this;
  var defer = libQ.defer();
  var lang_code = self.commandRouter.sharedVars.get('language_code');

  self.commandRouter.i18nJson(__dirname + '/i18n/strings_' + lang_code + '.json',
    __dirname + '/i18n/strings_en.json',
    __dirname + '/UIConfig.json')
    .then(function (uiconf) {
      try {
        var speed = self.config.get('ch341Speed', 2);

        uiconf.sections[0].content[0].value = self.config.get('oledModel', 'SSD1306,128X64_NONAME');
        uiconf.sections[0].content[1].value = self.config.get('xoffset', 0);
        uiconf.sections[0].content[2].value = self.config.get('i2cAddress', '');
        uiconf.sections[0].content[3].value = self.config.get('rotateDisplay', false);

        uiconf.sections[1].content[0].value = self.config.get('ch341Index', 0);
        uiconf.sections[1].content[1].value = {
          value: speed,
          label: self.speedLabel(speed)
        };

        uiconf.sections[2].content[0].value = self.config.get('numberOfBars', 20);
        uiconf.sections[2].content[1].value = self.config.get('gapBetweenBars', 2);
        uiconf.sections[2].content[2].value = self.config.get('frameRate', 50);
        uiconf.sections[2].content[3].value = self.config.get('spectrumEnabled', true);
        uiconf.sections[2].content[4].value = self.config.get('spectrumDelayMs', 0);
      } catch (e) {
        self.logger.error('ch341_oled: getUIConfig populate failed: ' + e);
      }

      defer.resolve(uiconf);
    })
    .fail(function (e) {
      self.logger.error('ch341_oled: getUIConfig failed: ' + e);
      defer.reject(new Error('ch341_oled: getUIConfig failed'));
    });

  return defer.promise;
};

ch341Oled.prototype.speedLabel = function (v) {
  var labels = { 0: '20 kHz', 1: '100 kHz', 2: '400 kHz (default)', 3: '750 kHz' };
  return labels[v] !== undefined ? labels[v] : '400 kHz (default)';
};

ch341Oled.prototype.uiValue = function (data, key, fallback) {
  var v = data && data[key];
  if (v && typeof v === 'object' && v.value !== undefined) {
    return v.value;
  }
  if (v === undefined || v === null || v === '') {
    return fallback;
  }
  return v;
};

ch341Oled.prototype.uiInt = function (data, key, fallback) {
  var n = parseInt(this.uiValue(data, key, fallback), 10);
  return isNaN(n) ? fallback : n;
};

ch341Oled.prototype.uiBool = function (data, key, fallback) {
  var v = this.uiValue(data, key, fallback);
  if (v === true || v === 'true' || v === 1 || v === '1') {
    return true;
  }
  if (v === false || v === 'false' || v === 0 || v === '0') {
    return false;
  }
  return !!fallback;
};

ch341Oled.prototype.saveDisplaySettings = function (data) {
  var self = this;

  try {
    self.config.set('oledModel', String(self.uiValue(data, 'oledModel', 'SSD1306,128X64_NONAME')));
    self.config.set('xoffset', self.uiInt(data, 'xoffset', 0));
    self.config.set('i2cAddress', String(self.uiValue(data, 'i2cAddress', '')).trim());
    self.config.set('rotateDisplay', self.uiBool(data, 'rotateDisplay', false));
  } catch (e) {
    self.logger.error('ch341_oled: saveDisplaySettings: ' + e);
    return self.reportSave(false);
  }

  return self.applyAndReport();
};

ch341Oled.prototype.saveAdapterSettings = function (data) {
  var self = this;

  try {
    self.config.set('ch341Index', self.uiInt(data, 'ch341Index', 0));
    self.config.set('ch341Speed', self.uiInt(data, 'ch341Speed', 2));
  } catch (e) {
    self.logger.error('ch341_oled: saveAdapterSettings: ' + e);
    return self.reportSave(false);
  }

  return self.applyAndReport();
};

ch341Oled.prototype.saveLayoutSettings = function (data) {
  var self = this;

  try {
    self.config.set('numberOfBars', self.uiInt(data, 'numberOfBars', 20));
    self.config.set('gapBetweenBars', self.uiInt(data, 'gapBetweenBars', 2));
    self.config.set('frameRate', self.uiInt(data, 'frameRate', 50));
    self.config.set('spectrumEnabled', self.uiBool(data, 'spectrumEnabled', true));
    self.config.set('spectrumDelayMs', self.uiInt(data, 'spectrumDelayMs', 0));
  } catch (e) {
    self.logger.error('ch341_oled: saveLayoutSettings: ' + e);
    return self.reportSave(false);
  }

  return self.applyAndReport();
};

ch341Oled.prototype.reportSave = function (ok) {
  var self = this;

  if (ok) {
    self.commandRouter.pushToastMessage('success',
      'CH341 OLED', self.commandRouter.getI18nString('COMMON.SETTINGS_SAVED_SUCCESSFULLY'));
  } else {
    self.commandRouter.pushToastMessage('error',
      'CH341 OLED', 'The display did not restart. Check the log.');
  }

  return libQ.resolve({});
};

ch341Oled.prototype.applyAndReport = function () {
  var self = this;

  return self.restartService()
    .then(function () {
      return self.reportSave(true);
    })
    .fail(function (e) {
      self.logger.error('ch341_oled: apply settings: ' + e);
      return self.reportSave(false);
    });
};

ch341Oled.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

ch341Oled.prototype.setUIConfig = function (data) {};
ch341Oled.prototype.getConf = function (varName) {};
ch341Oled.prototype.setConf = function (varName, varValue) {};
