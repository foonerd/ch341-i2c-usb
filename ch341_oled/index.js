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

  return libQ.resolve();
};

ch341Oled.prototype.onStart = function () {
  var self = this;
  var defer = libQ.defer();

  // Order matters. The FIFO must exist before the ALSA config is
  // regenerated, because regeneration makes MPD reopen the chain
  // immediately, and volumiofifo does not create the FIFO itself - if it
  // is missing the whole chain fails to resolve and playback stops with
  // "Failed to open ALSA device volumio".
  self.createFifo();

  self.writeStartScript();

  self.commandRouter.executeOnPlugin('audio_interface', 'alsa_controller',
    'updateALSAConfigFile', '');

  self.startService()
    .then(function () {
      defer.resolve();
    })
    .fail(function (e) {
      self.logger.error('ch341_oled: failed to start: ' + e);
      // Resolve anyway: a display that will not start should not block
      // the plugin from being enabled, or the user cannot reach the
      // settings page to correct it.
      defer.resolve();
    });

  return defer.promise;
};

/*
  Create the FIFO cava reads.

  Mode 646 so that ALSA, writing as whichever user owns the playback
  process, can open it for writing while cava reads it as volumio.

  Anything already at the path is removed first. A stale FIFO left by an
  unclean stop would make mkfifo fail with EEXIST, and an early version
  of this plugin used the ALSA "file" plugin, which creates a large
  regular file there instead. Either would break the chain with no
  obvious cause, so neither is tolerated.
*/
ch341Oled.prototype.createFifo = function () {
  var self = this;

  try {
    execSync('/bin/rm -f ' + FIFO, { uid: 1000, gid: 1000 });
  } catch (e) {
    self.logger.error('ch341_oled: cannot clear ' + FIFO + ': ' + e);
  }

  try {
    execSync('/usr/bin/mkfifo -m 646 ' + FIFO, { uid: 1000, gid: 1000 });
    self.logger.info('ch341_oled: created ' + FIFO);
  } catch (e) {
    self.logger.error('ch341_oled: cannot create ' + FIFO + ': ' + e);
  }
};

ch341Oled.prototype.removeFifo = function () {
  var self = this;

  try {
    execSync('/bin/rm -f ' + FIFO, { uid: 1000, gid: 1000 });
  } catch (e) {
    self.logger.error('ch341_oled: cannot remove ' + FIFO + ': ' + e);
  }
};

ch341Oled.prototype.onStop = function () {
  var self = this;
  var defer = libQ.defer();

  self.stopService()
    .then(function () {
      // Rebuild the chain without our contribution first, so nothing is
      // still writing to the FIFO when it is removed.
      self.commandRouter.executeOnPlugin('audio_interface', 'alsa_controller',
        'updateALSAConfigFile', '');
      self.removeFifo();
      defer.resolve();
    })
    .fail(function () {
      self.removeFifo();
      defer.resolve();
    });

  return defer.promise;
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
  } catch (e) {
    self.logger.error('ch341_oled: cannot write start script: ' + e);
  }
};

// ---------------------------------------------------------------- service

ch341Oled.prototype.systemctl = function (verb) {
  var self = this;
  var defer = libQ.defer();

  exec('/usr/bin/sudo /bin/systemctl ' + verb + ' ' + SERVICE + '.service',
    { uid: 1000, gid: 1000 },
    function (error) {
      if (error) {
        self.logger.error('ch341_oled: systemctl ' + verb + ' failed: ' + error);
        defer.reject(error);
      } else {
        defer.resolve();
      }
    });

  return defer.promise;
};

ch341Oled.prototype.startService = function () {
  return this.systemctl('start');
};

ch341Oled.prototype.stopService = function () {
  return this.systemctl('stop');
};

ch341Oled.prototype.restartService = function () {
  var self = this;
  self.writeStartScript();
  return self.systemctl('restart');
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
      // Section 0: display
      uiconf.sections[0].content[0].value = self.config.get('oledModel', 'SSD1306,128X64_NONAME');
      uiconf.sections[0].content[1].value = self.config.get('xoffset', 0);
      uiconf.sections[0].content[2].value = self.config.get('i2cAddress', '');
      uiconf.sections[0].content[3].value = self.config.get('rotateDisplay', false);

      // Section 1: adapter
      uiconf.sections[1].content[0].value = self.config.get('ch341Index', 0);
      uiconf.sections[1].content[1].value.value = self.config.get('ch341Speed', 2);
      uiconf.sections[1].content[1].value.label =
        self.speedLabel(self.config.get('ch341Speed', 2));

      // Section 2: layout
      uiconf.sections[2].content[0].value = self.config.get('numberOfBars', 20);
      uiconf.sections[2].content[1].value = self.config.get('gapBetweenBars', 2);
      uiconf.sections[2].content[2].value = self.config.get('frameRate', 50);
      uiconf.sections[2].content[3].value = self.config.get('spectrumEnabled', true);
      uiconf.sections[2].content[4].value = self.config.get('spectrumDelayMs', 0);

      defer.resolve(uiconf);
    })
    .fail(function (e) {
      self.logger.error('ch341_oled: getUIConfig failed: ' + e);
      defer.reject(new Error());
    });

  return defer.promise;
};

ch341Oled.prototype.speedLabel = function (v) {
  var labels = { 0: '20 kHz', 1: '100 kHz', 2: '400 kHz (default)', 3: '750 kHz' };
  return labels[v] !== undefined ? labels[v] : '400 kHz (default)';
};

ch341Oled.prototype.saveDisplaySettings = function (data) {
  var self = this;

  self.config.set('oledModel', data.oledModel);
  self.config.set('xoffset', parseInt(data.xoffset, 10) || 0);
  self.config.set('i2cAddress', (data.i2cAddress || '').trim());
  self.config.set('rotateDisplay', !!data.rotateDisplay);

  return self.applyAndReport();
};

ch341Oled.prototype.saveAdapterSettings = function (data) {
  var self = this;

  self.config.set('ch341Index', parseInt(data.ch341Index, 10) || 0);
  self.config.set('ch341Speed', parseInt(data.ch341Speed.value, 10));

  return self.applyAndReport();
};

ch341Oled.prototype.saveLayoutSettings = function (data) {
  var self = this;

  self.config.set('numberOfBars', parseInt(data.numberOfBars, 10) || 20);
  self.config.set('gapBetweenBars', parseInt(data.gapBetweenBars, 10) || 2);
  self.config.set('frameRate', parseInt(data.frameRate, 10) || 50);
  self.config.set('spectrumEnabled', !!data.spectrumEnabled);
  self.config.set('spectrumDelayMs', parseInt(data.spectrumDelayMs, 10) || 0);

  return self.applyAndReport();
};

ch341Oled.prototype.applyAndReport = function () {
  var self = this;
  var defer = libQ.defer();

  self.restartService()
    .then(function () {
      self.commandRouter.pushToastMessage('success',
        'CH341 OLED', self.commandRouter.getI18nString('COMMON.SETTINGS_SAVED_SUCCESSFULLY'));
      defer.resolve({});
    })
    .fail(function () {
      self.commandRouter.pushToastMessage('error',
        'CH341 OLED', 'The display did not restart. Check the log.');
      defer.resolve({});
    });

  return defer.promise;
};

ch341Oled.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

ch341Oled.prototype.setUIConfig = function (data) {};
ch341Oled.prototype.getConf = function (varName) {};
ch341Oled.prototype.setConf = function (varName, varValue) {};
