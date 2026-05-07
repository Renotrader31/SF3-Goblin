(function () {
  if (window.sf3LiveMonitorLoaded) {
    return;
  }

  window.sf3LiveMonitorLoaded = true;

  const SNAPSHOT_STORAGE_KEY = "sf3LiveMonitorSnapshot";
  const THRESHOLD_LABEL_SELECTOR = "text.highcharts-plot-line-label";
  const PRICE_SELECTOR = "span.higlight-number.shade1";
  const METRICS_MODAL_SELECTOR = "#movableModal .movable-modal-content > div[style*='padding: 30px']";
  const METRICS_MODAL_XPATH = "/html/body/div/div[1]/main/div[6]/div/div[1]/div/div[2]";
  const FALLBACK_SF3_THRESHOLD_XPATHS = [
    "/html/body/div/div[1]/main/div[1]/div[2]/div[3]/div[1]/svg/text[10]",
    "/html/body/div/div[1]/main/div[1]/div[2]/div[3]/div[1]/svg/text[11]"
  ];

  let observer = null;
  let intervalId = null;
  let scanTimeoutId = null;
  let scanQueued = false;
  let forcePending = false;
  let lastSignature = "";

  function stopMonitoring() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (intervalId != null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }

    if (scanTimeoutId != null) {
      window.clearTimeout(scanTimeoutId);
      scanTimeoutId = null;
    }

    window.sf3LiveMonitorLoaded = false;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\u200b/g, " ").replace(/\s+/g, " ").trim();
  }

  function parseCompactNumber(value) {
    const normalized = normalizeText(value).replace(/,/g, "");
    if (!normalized) {
      return null;
    }

    const match = normalized.match(/^([+-]?\d*\.?\d+)([KMBT])?$/i);
    if (!match) {
      return null;
    }

    const number = Number.parseFloat(match[1]);
    if (!Number.isFinite(number)) {
      return null;
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

    return number * multiplier;
  }

  function getLiveTileValues() {
    const values = {};
    const groups = [...document.querySelectorAll(".live-updates-graph")];

    for (const group of groups) {
      const headingParagraphs = [...group.querySelectorAll(".heading-mobile p")];
      const label = normalizeText(
        headingParagraphs[0]?.textContent ||
        group.querySelector("textPath")?.textContent ||
        group.querySelector(".heading p")?.textContent ||
        ""
      ).toUpperCase();
      const value = normalizeText(
        group.querySelector(".graph-block .value.svelte-kxaiyw")?.textContent ||
        headingParagraphs[1]?.textContent ||
        group.querySelector(".value.svelte-kxaiyw")?.textContent ||
        ""
      );

      if (label && value) {
        values[label] = value;
      }
    }

    return values;
  }

  function nodeHasMetricsRows(node) {
    if (!(node instanceof Element)) {
      return false;
    }

    const text = normalizeText(node.textContent || "");
    return text.includes("MomoFlow:") && text.includes("NOFA:");
  }

  function getMetricsModalContainer() {
    const directMatch = document.querySelector(METRICS_MODAL_SELECTOR);
    if (nodeHasMetricsRows(directMatch)) {
      return directMatch;
    }

    const modalRoot = document.querySelector("#movableModal");
    if (modalRoot) {
      const candidates = [...modalRoot.querySelectorAll("div")];
      const contentMatch = candidates.find((candidate) => nodeHasMetricsRows(candidate));
      if (contentMatch) {
        return contentMatch;
      }
    }

    try {
      const result = document.evaluate(METRICS_MODAL_XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const xpathMatch = result.singleNodeValue;
      if (nodeHasMetricsRows(xpathMatch)) {
        return xpathMatch;
      }
    } catch {
      return null;
    }

    return null;
  }

  function getModalMetrics() {
    const container = getMetricsModalContainer();
    if (!container) {
      return {};
    }

    const result = {};
    const children = [...container.children];

    for (const child of children) {
      const spans = child.querySelectorAll("span");
      if (!spans.length) {
        continue;
      }

      const label = normalizeText(spans[0].textContent);
      const value = normalizeText(child.textContent.replace(spans[0].textContent, ""));

      if (label === "MomoFlow:") {
        result.momoFlow = value;
      }

      if (label === "NOFA:") {
        result.nof = value;
      }
    }

    return result;
  }

  function getCurrentPrice() {
    const element = document.querySelector(PRICE_SELECTOR);
    const text = normalizeText(element?.textContent || "");

    return {
      text,
      value: parseCompactNumber(text),
      source: text ? "banner" : ""
    };
  }

  function queryXPathText(xpath) {
    try {
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return normalizeText(result.singleNodeValue?.textContent || "");
    } catch {
      return "";
    }
  }

  function getThresholds() {
    const thresholds = {
      sf3: { upperText: "", lowerText: "", upper: null, lower: null },
      nof: { upperText: "", lowerText: "", upper: null, lower: null },
      mf: { upperText: "", lowerText: "", upper: null, lower: null }
    };

    const labels = [...document.querySelectorAll(THRESHOLD_LABEL_SELECTOR)].map((node) => normalizeText(node.textContent));

    for (const text of labels) {
      const match = text.match(/^(SF3|NOF|MF)\s+(.+)$/i);
      if (!match) {
        continue;
      }

      const metric = match[1].toUpperCase() === "MF" ? "mf" : match[1].toLowerCase();
      const valueText = normalizeText(match[2]);
      const value = parseCompactNumber(valueText);
      if (value == null) {
        continue;
      }

      if (value >= 0) {
        thresholds[metric].upper = value;
        thresholds[metric].upperText = valueText;
      } else {
        thresholds[metric].lower = value;
        thresholds[metric].lowerText = valueText;
      }
    }

    if (!thresholds.sf3.upperText || !thresholds.sf3.lowerText) {
      for (const xpath of FALLBACK_SF3_THRESHOLD_XPATHS) {
        const text = queryXPathText(xpath);
        const match = text.match(/^(SF3)\s+(.+)$/i);
        if (!match) {
          continue;
        }

        const valueText = normalizeText(match[2]);
        const value = parseCompactNumber(valueText);
        if (value == null) {
          continue;
        }

        if (value >= 0) {
          thresholds.sf3.upper = value;
          thresholds.sf3.upperText = valueText;
        } else {
          thresholds.sf3.lower = value;
          thresholds.sf3.lowerText = valueText;
        }
      }
    }

    return thresholds;
  }

  function buildSnapshot() {
    const liveTiles = getLiveTileValues();
    const modalMetrics = getModalMetrics();
    const price = getCurrentPrice();
    const thresholds = getThresholds();

    const values = {
      sf3: liveTiles.SF3 || "",
      nof: modalMetrics.nof || "",
      momoFlow: modalMetrics.momoFlow || "",
      price: price.text || ""
    };

    if (!values.sf3 && !values.nof && !values.momoFlow && price.value == null) {
      return null;
    }

    return {
      timestamp: new Date().toISOString(),
      pageUrl: window.location.href,
      values,
      numericValues: {
        sf3: parseCompactNumber(values.sf3),
        nof: parseCompactNumber(values.nof),
        momoFlow: parseCompactNumber(values.momoFlow),
        price: price.value
      },
      thresholds,
      sources: {
        sf3: liveTiles.SF3 ? "tile" : "",
        nof: modalMetrics.nof ? "modal" : "",
        momoFlow: modalMetrics.momoFlow ? "modal" : "",
        price: price.source
      }
    };
  }

  async function persistSnapshot(snapshot) {
    try {
      await chrome.runtime.sendMessage({
        type: "sf3-live-monitor-publish-snapshot",
        snapshot
      });
    } catch (error) {
      const message = String(error?.message || error || "");
      if (message.includes("Extension context invalidated")) {
        stopMonitoring();
        return;
      }

      console.warn("[SF3 Live Monitor] Failed to persist snapshot:", error);
    }
  }

  function flushScanQueue() {
    scanQueued = false;
    scanTimeoutId = null;

    const force = forcePending;
    forcePending = false;

    const snapshot = buildSnapshot();
    if (!snapshot) {
      return;
    }

    const signature = JSON.stringify({
      values: snapshot.values,
      thresholds: snapshot.thresholds,
      sources: snapshot.sources
    });

    if (!force && signature === lastSignature) {
      return;
    }

    lastSignature = signature;
    void persistSnapshot(snapshot);
  }

  function queueScan(options = {}) {
    const { force = false } = options;
    forcePending = forcePending || force;

    if (scanQueued) {
      return;
    }

    scanQueued = true;
    scanTimeoutId = window.setTimeout(flushScanQueue, 0);
  }

  function startObserver() {
    if (observer) {
      return;
    }

    observer = new MutationObserver(() => {
      queueScan();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class", "opacity", "visibility", "transform"]
    });
  }

  function init() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "sf3-live-monitor-force-scan") {
        queueScan({ force: true });
      }
    });

    startObserver();
    intervalId = window.setInterval(queueScan, 1000);
    queueScan({ force: true });
  }

  init();
})();