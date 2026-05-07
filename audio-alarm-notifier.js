class AudioAlarmNotifier {
  constructor() {
    this.audioContext = null;
    this.isPlaying = false;
    this.timeoutId = null;
    this.intervalId = null;
    this.volume = 0.28;
    this.highFrequency = 880;
    this.lowFrequency = 440;
    this.toneDurationMs = 180;
    this.totalDurationMs = 2400;
  }

  async initAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    return true;
  }

  playTone(frequency, durationSeconds) {
    if (!this.audioContext || !this.isPlaying) {
      return;
    }

    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    const now = this.audioContext.currentTime;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, now);

    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(this.volume, now + 0.01);
    gainNode.gain.linearRampToValueAtTime(this.volume, now + durationSeconds - 0.02);
    gainNode.gain.linearRampToValueAtTime(0, now + durationSeconds);

    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + durationSeconds);
  }

  async playAlarm() {
    if (this.isPlaying) {
      return;
    }

    await this.initAudioContext();
    this.isPlaying = true;

    let useHighTone = true;
    const tick = () => {
      if (!this.isPlaying) {
        return;
      }

      this.playTone(useHighTone ? this.highFrequency : this.lowFrequency, this.toneDurationMs / 1000);
      useHighTone = !useHighTone;
    };

    tick();
    this.intervalId = window.setInterval(tick, this.toneDurationMs);
    this.timeoutId = window.setTimeout(() => {
      this.stopAlarm();
    }, this.totalDurationMs);
  }

  stopAlarm() {
    if (!this.isPlaying) {
      return;
    }

    this.isPlaying = false;

    if (this.intervalId) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.timeoutId) {
      window.clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
}

window.audioAlarmNotifier = new AudioAlarmNotifier();