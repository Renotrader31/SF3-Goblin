class SingleAlarmManager {
  constructor() {
    this.storageKey = "sf3LiveMonitorSingleAlarmState";
    this.defaultState = {
      alarm: null,
      triggerHistory: [],
      hasTriggeredThisBoundary: false,
      currentBoundaryStart: null
    };
    this.state = this.loadState();
  }

  loadState() {
    try {
      const rawState = window.localStorage.getItem(this.storageKey);
      if (!rawState) {
        return { ...this.defaultState };
      }

      const parsedState = JSON.parse(rawState);
      return {
        alarm: parsedState?.alarm || null,
        triggerHistory: Array.isArray(parsedState?.triggerHistory) ? parsedState.triggerHistory : [],
        hasTriggeredThisBoundary: Boolean(parsedState?.hasTriggeredThisBoundary),
        currentBoundaryStart: parsedState?.currentBoundaryStart || null
      };
    } catch (error) {
      console.warn("Failed to load alarm state", error);
      return { ...this.defaultState };
    }
  }

  saveState() {
    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(this.state));
    } catch (error) {
      console.warn("Failed to persist alarm state", error);
    }
  }

  reloadFromStorage() {
    this.state = this.loadState();
    return this.state;
  }

  isStorageKey(key) {
    return key === this.storageKey;
  }

  getCurrentAlarm() {
    return this.state.alarm;
  }

  getTriggerHistory() {
    return this.state.triggerHistory;
  }

  getMostRecent5MinuteBoundary(referenceTime = new Date()) {
    const boundary = new Date(referenceTime);
    boundary.setMinutes(Math.floor(boundary.getMinutes() / 5) * 5, 0, 0);
    return boundary;
  }

  updateCurrentBoundary(referenceTime = new Date()) {
    const nextBoundary = this.getMostRecent5MinuteBoundary(referenceTime).toISOString();
    if (this.state.currentBoundaryStart !== nextBoundary) {
      this.state.currentBoundaryStart = nextBoundary;
      this.state.hasTriggeredThisBoundary = false;
      this.saveState();
    }
  }

  hasTriggeredCurrentBoundary(referenceTime = new Date()) {
    this.updateCurrentBoundary(referenceTime);
    return this.state.hasTriggeredThisBoundary;
  }

  resetBoundaryState(referenceTime = new Date()) {
    this.state.currentBoundaryStart = this.getMostRecent5MinuteBoundary(referenceTime).toISOString();
    this.state.hasTriggeredThisBoundary = false;
    this.saveState();
  }

  clearTriggerHistory() {
    this.state.triggerHistory = [];
    this.saveState();
  }

  parseThreshold(metric, thresholdInput) {
    const normalized = String(thresholdInput || "").trim().replace(/,/g, "");
    if (!normalized) {
      throw new Error("Enter a threshold value.");
    }

    if (metric === "price") {
      const priceThreshold = Number.parseFloat(normalized);
      if (!Number.isFinite(priceThreshold)) {
        throw new Error("Price alarms use values like 0.05 or -0.10.");
      }
      return priceThreshold;
    }

    const match = normalized.match(/^([+-]?\d*\.?\d+)([KMBT]?)$/i);
    if (!match) {
      throw new Error("Metric alarms support plain numbers plus K, M, B, or T.");
    }

    const baseValue = Number.parseFloat(match[1]);
    if (!Number.isFinite(baseValue)) {
      throw new Error("Enter a valid numeric threshold.");
    }

    const suffix = (match[2] || "").toUpperCase();
    const multiplier = suffix === "K"
      ? 1e3
      : suffix === "M"
        ? 1e6
        : suffix === "B"
          ? 1e9
          : suffix === "T"
            ? 1e12
            : 1;

    return baseValue * multiplier;
  }

  evaluateThreshold(currentValue) {
    if (!this.state.alarm) {
      return false;
    }

    const { threshold, isAbsolute } = this.state.alarm;
    if (isAbsolute) {
      return Math.abs(currentValue) >= Math.abs(threshold);
    }

    return threshold >= 0 ? currentValue >= threshold : currentValue <= threshold;
  }

  createAlarm({ metric, thresholdInput, isAbsolute = false }) {
    const threshold = this.parseThreshold(metric, thresholdInput);
    const createdAt = new Date().toISOString();

    this.state = {
      alarm: {
        metric,
        threshold,
        thresholdInput: String(thresholdInput).trim(),
        isAbsolute: Boolean(isAbsolute),
        createdAt,
        isActive: true
      },
      triggerHistory: [],
      hasTriggeredThisBoundary: false,
      currentBoundaryStart: this.getMostRecent5MinuteBoundary(new Date()).toISOString()
    };

    this.saveState();
    return this.state.alarm;
  }

  deleteAlarm() {
    this.state = { ...this.defaultState };
    this.saveState();
  }

  acknowledgeAlarm() {
    if (window.audioAlarmNotifier) {
      window.audioAlarmNotifier.stopAlarm();
    }
  }

  checkAlarm(currentValue, currentMetric, referenceTime = new Date()) {
    if (!this.state.alarm || !this.state.alarm.isActive) {
      return null;
    }

    if (this.state.alarm.metric !== currentMetric) {
      return null;
    }

    if (currentValue == null || !Number.isFinite(currentValue)) {
      return null;
    }

    this.updateCurrentBoundary(referenceTime);
    if (this.state.hasTriggeredThisBoundary || !this.evaluateThreshold(currentValue)) {
      return null;
    }

    const triggerEvent = {
      timestamp: new Date(referenceTime).toISOString(),
      metric: currentMetric,
      value: currentValue,
      threshold: this.state.alarm.threshold,
      isAbsolute: this.state.alarm.isAbsolute
    };

    this.state.triggerHistory.unshift(triggerEvent);
    this.state.triggerHistory = this.state.triggerHistory.slice(0, 10);
    this.state.hasTriggeredThisBoundary = true;
    this.saveState();
    return triggerEvent;
  }
}

window.singleAlarmManager = new SingleAlarmManager();