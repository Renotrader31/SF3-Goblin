(function () {
  if (window.sf3LiveMonitorLoaded) {
    return;
  }

  window.sf3LiveMonitorLoaded = true;

  const SNAPSHOT_STORAGE_KEY = "sf3LiveMonitorSnapshot";
  const TOOLTIP_ROOT_SELECTOR = "g.highcharts-tooltip, div.highcharts-tooltip";
  const THRESHOLD_LABEL_SELECTOR = "text.highcharts-plot-line-label";
  const PRICE_SELECTOR = "span.higlight-number.shade1";
  const FALLBACK_SF3_THRESHOLD_XPATHS = [
    "/html/body/div/div[1]/main/div[1]/div[2]/div[3]/div[1]/svg/text[10]",
    "/html/body/div/div[1]/main/div[1]/div[2]/div[3]/div[1]/svg/text[11]"
  ];

  let observer = null;
  let intervalId = null;
  let scanQueued = false;
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

  function isVisible(element) {
    if (!element) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const visibility = element.getAttribute("visibility") || style.visibility;
    const opacityValue = element.getAttribute("opacity") || style.opacity || "1";
    const opacity = Number.parseFloat(opacityValue);

    return visibility !== "hidden" && style.display !== "none" && opacity > 0;
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

  function extractMetricTextsFromNodes(nodes) {
    const result = {};

    for (const node of nodes) {
      const text = normalizeText(node.textContent || "");
      if (!text) {
        continue;
      }

      const momoMatch = text.match(/MomoFlow:\s*(.+)$/i);
      if (momoMatch && !result.momoFlow) {
        result.momoFlow = normalizeText(momoMatch[1]);
      }

      const nofMatch = text.match(/(?:NOFA|NOF):\s*(.+)$/i);
      if (nofMatch && !result.nof) {
        result.nof = normalizeText(nofMatch[1]);
      }
    }

    return result;
  }

  function getTooltipMetrics() {
    const tooltipRoots = [...document.querySelectorAll(TOOLTIP_ROOT_SELECTOR)];
    let fallback = {};

    for (const root of tooltipRoots) {
      const nodes = [...root.querySelectorAll("text, span, div, p")];
      const extracted = extractMetricTextsFromNodes(nodes);
      if (!Object.keys(extracted).length) {
        continue;
      }

      if (isVisible(root)) {
        return extracted;
      }

      fallback = { ...fallback, ...extracted };
    }

    return fallback;
  }

  function getModalMetrics() {
    const container = document.querySelector("#movableModal div[style*='padding: 30px']");
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
    const tooltipMetrics = getTooltipMetrics();
    const modalMetrics = getModalMetrics();
    const price = getCurrentPrice();
    const thresholds = getThresholds();

    const values = {
      sf3: liveTiles.SF3 || "",
      nof: tooltipMetrics.nof || modalMetrics.nof || "",
      momoFlow: tooltipMetrics.momoFlow || modalMetrics.momoFlow || "",
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
        nof: tooltipMetrics.nof ? "tooltip" : modalMetrics.nof ? "modal" : "",
        momoFlow: tooltipMetrics.momoFlow ? "tooltip" : modalMetrics.momoFlow ? "modal" : "",
        price: price.source
      }
    };
  }

  async function persistSnapshot(snapshot) {
    try {
      await chrome.storage.local.set({
        [SNAPSHOT_STORAGE_KEY]: snapshot
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

  function queueScan() {
    if (scanQueued) {
      return;
    }

    scanQueued = true;
    window.requestAnimationFrame(() => {
      scanQueued = false;

      const snapshot = buildSnapshot();
      if (!snapshot) {
        return;
      }

      const signature = JSON.stringify({
        values: snapshot.values,
        thresholds: snapshot.thresholds,
        sources: snapshot.sources
      });

      if (signature === lastSignature) {
        return;
      }

      lastSignature = signature;
      void persistSnapshot(snapshot);
    });
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
    startObserver();
    intervalId = window.setInterval(queueScan, 1000);
    queueScan();
  }

  init();
})();