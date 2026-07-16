const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const profileDir = path.join(root, "data", "browser-profile", "kdocs");
const snapshotDir = path.join(root, "data", "kdocs");
const defaultUrl = "https://kdocs.cn/l/ciUyT3wSXLX0";
const defaultPort = Number(process.env.KDOCS_DEBUG_PORT || 9223);

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function main() {
  const command = process.argv[2] || "status";
  const url = process.argv[3] || defaultUrl;
  const port = Number(process.argv[4] || defaultPort);

  if (command === "open") {
    console.log(JSON.stringify(openBrowser(url, port), null, 2));
    return;
  }

  if (command === "status") {
    console.log(JSON.stringify(await getStatus(port), null, 2));
    return;
  }

  if (command === "collect") {
    console.log(JSON.stringify(await collect(url, port), null, 2));
    return;
  }

  if (command === "dismiss") {
    console.log(JSON.stringify(await dismissPageOverlay(url, port), null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function dismissPageOverlay(url, port) {
  await ensureBrowser(url, port);
  const page = await findOrOpenPage(url, port);
  const socket = await CdpSocket.connect(page.webSocketDebuggerUrl);
  try {
    await socket.send("Runtime.enable");
    return await dismissBlockingOverlay(socket);
  } finally {
    socket.close();
  }
}

function openBrowser(url, port) {
  const browser = findBrowser();
  if (!browser) {
    throw new Error("未找到 Chrome/Edge，请设置 CHROME_PATH。");
  }

  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(browser, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--disable-default-apps",
    url
  ], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  return {
    ok: true,
    browser,
    profileDir,
    port,
    url,
    next: "在打开的浏览器里确认能看到 AH 收货行情表；之后运行 collect。"
  };
}

async function getStatus(port) {
  try {
    const version = await getJson(`http://127.0.0.1:${port}/json/version`);
    const pages = await getJson(`http://127.0.0.1:${port}/json`);
    return {
      running: true,
      browser: version.Browser,
      port,
      pages: pages.map((page) => ({ id: page.id, title: page.title, url: page.url }))
    };
  } catch (error) {
    return {
      running: false,
      port,
      message: error.message
    };
  }
}

async function collect(url, port) {
  await ensureBrowser(url, port);
  const page = await findOrOpenPage(url, port);
  const socket = await CdpSocket.connect(page.webSocketDebuggerUrl);

  try {
    await socket.send("Runtime.enable");
    await socket.send("Page.enable");
    await socket.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1600,
      deviceScaleFactor: Number(process.env.KDOCS_DEVICE_SCALE || 2),
      mobile: false
    });
    await sleep(2500);
    await dismissBlockingOverlay(socket);

    const textResult = await socket.send("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true
    });
    const titleResult = await socket.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true
    });
    const locationResult = await socket.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true
    });
    const tableResult = await socket.send("Runtime.evaluate", {
      expression: "Array.from(document.querySelectorAll('table tr')).map(tr => Array.from(tr.cells).map(td => td.innerText).join('\\t')).join('\\n')",
      returnByValue: true
    });
    const resourceResult = await socket.send("Runtime.evaluate", {
      expression: "performance.getEntriesByType('resource').map(e => e.name).filter(n => /kdocs|wps|sheet|xlsx|csv|export|download|file|cell|range/i.test(n)).slice(-300)",
      returnByValue: true
    });
    const resources = resourceResult.result?.result?.value || [];
    const apiCandidates = resources
      .filter((item) => /https:\/\/www\.kdocs\.cn\/api|https:\/\/drive\.kdocs\.cn\/api|https:\/\/vas2t-api\.kdocs\.cn\//.test(item))
      .filter((item) => !/log|events\/collect|jsmetric|userinfo|configure|cards|comments|newtips|customsettings/.test(item))
      .slice(0, 40);
    const apiResult = await socket.send("Runtime.evaluate", {
      expression: `(${async function fetchApiSamples(urls) {
        const samples = [];
        for (const url of urls) {
          try {
            const response = await fetch(url, { credentials: "include" });
            const text = await response.text();
            samples.push({
              url,
              status: response.status,
              contentType: response.headers.get("content-type") || "",
              length: text.length,
              text: text.slice(0, 8000)
            });
          } catch (error) {
            samples.push({ url, error: error.message });
          }
        }
        return samples;
      }.toString()})(${JSON.stringify(apiCandidates)})`,
      awaitPromise: true,
      returnByValue: true
    });

    const collectedAt = new Date().toISOString();
    const stamp = collectedAt.replace(/[:.]/g, "-");
    const outlineJump = await jumpToLatestOutline(socket);
    if (!outlineJump.clicked || !outlineJump.nextText) {
      throw new Error("未能确定 KDocs 最新目录及下一目录，已取消本次更新。 ");
    }
    await sleep(1600);
    const outlineRange = await measureOutlineRange(socket, outlineJump);
    const imageCapture = await captureScrollableScreenshots(
      socket,
      path.join(snapshotDir, `ah-kdocs-images-${stamp}`),
      outlineRange
    );
    if (!imageCapture.complete) {
      throw new Error(`KDocs 截图不完整：需要 ${imageCapture.requiredPages} 屏，实际 ${imageCapture.capturedPages} 屏。`);
    }

    const snapshot = {
      collectedAt,
      title: titleResult.result?.result?.value || "",
      url: locationResult.result?.result?.value || page.url,
      text: textResult.result?.result?.value || "",
      tableText: tableResult.result?.result?.value || "",
      resources,
      apiSamples: apiResult.result?.result?.value || [],
      outlineJump,
      imageCapture
    };

    fs.mkdirSync(snapshotDir, { recursive: true });
    const jsonPath = path.join(snapshotDir, `ah-kdocs-${stamp}.json`);
    const latestJsonPath = path.join(snapshotDir, "ah-kdocs-latest.json");
    const latestTextPath = path.join(root, "data", "inbox", "quotes", "ah-kdocs-latest.txt");
    fs.mkdirSync(path.dirname(latestTextPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), "utf8");
    fs.writeFileSync(latestJsonPath, JSON.stringify(snapshot, null, 2), "utf8");
    fs.writeFileSync(latestTextPath, [snapshot.tableText, snapshot.text].filter(Boolean).join("\n"), "utf8");

    return {
      ok: true,
      title: snapshot.title,
      url: snapshot.url,
      textLength: snapshot.text.length,
      tableTextLength: snapshot.tableText.length,
      resources: snapshot.resources.length,
      apiSamples: snapshot.apiSamples.length,
      imageCount: snapshot.imageCapture.paths.length,
      latestImagePaths: snapshot.imageCapture.paths,
      captureComplete: snapshot.imageCapture.complete,
      requiredPages: snapshot.imageCapture.requiredPages,
      capturedPages: snapshot.imageCapture.capturedPages,
      outlineText: snapshot.outlineJump.text,
      outlineRange,
      jsonPath,
      latestJsonPath,
      latestTextPath,
      note: snapshot.text.length || snapshot.tableText.length
        ? "已采集页面文本。下一步根据 latest 文件补 AH 表解析规则。"
        : "没有采集到正文，可能表格是 canvas 渲染；下一步需要走截图 OCR 或内部接口解析。"
    };
  } finally {
    socket.close();
  }
}

async function jumpToLatestOutline(socket) {
  await dismissBlockingOverlay(socket);
  const result = await socket.send("Runtime.evaluate", {
    expression: `(${function findOutlines() {
      return [...document.querySelectorAll("*")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
          const match = text.match(/^(\d{2})-(\d{1,2})-(\d{2})\s*\u6536\u8d27\u884c\u60c5$/);
          const dateKey = match ? Number(`20${match[1]}${match[2].padStart(2, "0")}${match[3]}`) : 0;
          return {
            text,
            dateKey,
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            area: Math.round(rect.width * rect.height),
            visible: rect.width > 20 && rect.height > 10 && rect.top >= 120 && rect.bottom <= window.innerHeight
          };
        })
        .filter((item) => item.x >= 0 && item.x < 360 && item.dateKey > 0 && item.visible)
        .sort((a, b) => a.area - b.area)
        .filter((item, index, list) => list.findIndex((other) => other.text === item.text) === index)
        .sort((a, b) => b.dateKey - a.dateKey || a.text.length - b.text.length);
    }.toString()})()`,
    returnByValue: true
  });
  const candidates = result.result?.result?.value || [];
  const target = candidates[0];
  if (!target) return { clicked: false, availableOutlines: [] };
  const click = await clickPoint(socket, target.x, target.y);
  return {
    clicked: click.clicked,
    text: target.text,
    nextText: candidates[1]?.text || "",
    dateKey: target.dateKey,
    availableOutlines: candidates.map((item) => item.text)
  };
}

async function clickOutline(socket, text) {
  await dismissBlockingOverlay(socket);
  const result = await socket.send("Runtime.evaluate", {
    expression: `(${function findPoint(targetText) {
      const candidates = [...document.querySelectorAll("*")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            width: rect.width,
            height: rect.height,
            area: rect.width * rect.height,
            top: rect.top,
            bottom: rect.bottom
          };
        })
        .filter((item) => item.text === targetText && item.x >= 0 && item.x < 360)
        .filter((item) => item.width > 20 && item.height > 10 && item.top >= 120 && item.bottom <= window.innerHeight)
        .sort((a, b) => a.area - b.area);
      return candidates[0] || null;
    }.toString()})(${JSON.stringify(text)})`,
    returnByValue: true
  });
  const point = result.result?.result?.value;
  if (!point) return { clicked: false };
  const click = await clickPoint(socket, point.x, point.y);
  return { clicked: click.clicked, point, hit: click.hit };
}

async function dismissBlockingOverlay(socket) {
  await socket.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await socket.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  const result = await socket.send("Runtime.evaluate", {
    expression: `(${function dismiss() {
      const closed = [];
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const invitationPattern = /邀请你登录一起查看|查看\/编辑文档|登录并查看/;
      const dialogCandidates = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], div')]
        .filter((element) => {
          if (!visible(element)) return false;
          const rect = element.getBoundingClientRect();
          const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
          return rect.width >= 300 && rect.width <= 900 && rect.height >= 180 && rect.height <= 700 && invitationPattern.test(text);
        })
        .sort((left, right) => {
          const a = left.getBoundingClientRect();
          const b = right.getBoundingClientRect();
          return a.width * a.height - b.width * b.height;
        });

      const dialog = dialogCandidates[0];
      if (dialog) {
        const dialogRect = dialog.getBoundingClientRect();
        const closeCandidates = [...dialog.querySelectorAll('button, [role="button"], [aria-label], [title], svg')]
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.textContent || ""}`.trim();
            const explicit = /关闭|close/i.test(label) || /^[×✕✖xX]$/.test(label);
            const topRight = rect.width <= 64 && rect.height <= 64 && rect.left >= dialogRect.right - 100 && rect.top <= dialogRect.top + 100;
            return { element, explicit, topRight, area: rect.width * rect.height, label };
          })
          .filter((item) => item.explicit || item.topRight)
          .sort((left, right) => Number(right.explicit) - Number(left.explicit) || Number(right.topRight) - Number(left.topRight) || left.area - right.area);
        const close = closeCandidates[0];
        if (close) {
          const clickable = close.element.closest('button, [role="button"]') || close.element;
          clickable.click();
          closed.push({ label: close.label, method: close.explicit ? "label" : "top-right" });
        }
      }

      const disabled = [];
      for (const element of document.querySelectorAll(".shadow")) {
        const rect = element.getBoundingClientRect();
        const text = String(element.innerText || element.textContent || "").trim();
        const coversOutline = rect.left <= 100 && rect.right >= 200 && rect.top <= 320 && rect.bottom >= 500;
        if (!text && coversOutline) {
          element.style.pointerEvents = "none";
          disabled.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
        }
      }
      return { closed, disabled };
    }.toString()})()`,
    returnByValue: true
  });
  return result.result?.result?.value || { closed: [], disabled: [] };
}

async function clickPoint(socket, x, y) {
  const hitResult = await socket.send("Runtime.evaluate", {
    expression: `(${function hit(px, py) {
      const element = document.elementFromPoint(px, py);
      return element ? {
        tag: element.tagName,
        className: String(element.className || "").slice(0, 160),
        text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
        ancestors: [...function* parents(node) {
          let current = node;
          for (let index = 0; current && index < 6; index += 1, current = current.parentElement) yield current;
        }(element)].map((node) => ({
          tag: node.tagName,
          className: String(node.className || "").slice(0, 120),
          role: node.getAttribute("role") || "",
          dataId: node.getAttribute("data-id") || node.getAttribute("data-node-id") || ""
        }))
      } : null;
    }.toString()})(${Number(x)}, ${Number(y)})`,
    returnByValue: true
  });
  await socket.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await socket.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await socket.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await socket.send("Runtime.evaluate", {
    expression: `(${function activate(px, py) {
      const element = document.elementFromPoint(px, py);
      const button = element?.closest?.('[role="button"]') || element;
      if (button && typeof button.click === "function") button.click();
    }.toString()})(${Number(x)}, ${Number(y)})`
  });
  return { clicked: true, hit: hitResult.result?.result?.value || null };
}

async function measureOutlineRange(socket, outline) {
  const beforeCandidates = await getScrollDiagnostics(socket);
  const startMeta = await getScrollMeta(socket, null);
  const nextClick = await clickOutline(socket, outline.nextText);
  if (!nextClick.clicked) throw new Error(`未找到下一目录：${outline.nextText}`);
  await sleep(1600);
  const afterCandidates = await getScrollDiagnostics(socket);
  const endMeta = await getScrollMeta(socket, null);
  const restore = await clickOutline(socket, outline.text);
  if (!restore.clicked) throw new Error(`无法返回最新目录：${outline.text}`);
  await sleep(1600);
  const restoredMeta = await getScrollMeta(socket, null);
  const start = restoredMeta.scrollTop;
  const end = endMeta.scrollTop;
  if (!(end > start + Math.max(300, restoredMeta.clientHeight * 0.25))) {
    throw new Error(`KDocs 目录区间异常：${start} -> ${end}; ${JSON.stringify({ nextClick, beforeCandidates, afterCandidates })}`);
  }
  return {
    start,
    end,
    scrollHeight: restoredMeta.scrollHeight,
    clientHeight: restoredMeta.clientHeight,
    startMeta,
    endMeta
  };
}

async function getScrollDiagnostics(socket) {
  const result = await socket.send("Runtime.evaluate", {
    expression: `(${function diagnose() {
      function selectorOf(element) {
        if (element === document.scrollingElement) return "document.scrollingElement";
        const id = element.id ? `#${element.id}` : "";
        const classes = String(element.className || "").trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
        return `${element.tagName}${id}${classes ? `.${classes}` : ""}`.slice(0, 180);
      }
      return [document.scrollingElement, ...document.querySelectorAll("main,section,article,div")]
        .filter(Boolean)
        .filter((element, index, list) => list.indexOf(element) === index)
        .filter((element) => element.scrollHeight > element.clientHeight + 100)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            selector: selectorOf(element),
            top: Math.round(element.scrollTop || 0),
            height: Math.round(element.scrollHeight),
            client: Math.round(element.clientHeight),
            left: Math.round(rect.left),
            width: Math.round(rect.width)
          };
        })
        .sort((a, b) => (b.height - b.client) - (a.height - a.client))
        .slice(0, 20);
    }.toString()})()`,
    returnByValue: true
  });
  return result.result?.result?.value || [];
}

async function captureScrollableScreenshots(socket, outputDir, range) {
  fs.mkdirSync(outputDir, { recursive: true });
  const firstMeta = await getScrollMeta(socket, range.start);
  const step = Math.max(300, Math.round(firstMeta.clientHeight * 0.72));
  const lastTop = Math.max(range.start, range.end - Math.round(firstMeta.clientHeight * 0.68));
  const positions = [];
  for (let top = range.start; top < lastTop; top += step) positions.push(Math.round(top));
  positions.push(Math.round(lastTop));
  const uniquePositions = [...new Set(positions)];
  const requiredPages = uniquePositions.length;
  const maxPages = Math.max(1, Number(process.env.KDOCS_SCREENSHOT_PAGES || 120));
  const capturePositions = uniquePositions.slice(0, maxPages);
  const paths = [];
  const metas = [];

  for (let index = 0; index < capturePositions.length; index += 1) {
    const targetTop = capturePositions[index];
    const meta = await getScrollMeta(socket, targetTop);
    metas.push(meta);
    await sleep(900);
    const clips = await getVisibleDocumentClips(socket);
    for (let clipIndex = 0; clipIndex < clips.length; clipIndex += 1) {
      const clip = clips[clipIndex];
      const screenshot = await socket.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
        clip: {
          x: Math.max(0, Math.round(clip.x)),
          y: Math.max(0, Math.round(clip.y)),
          width: Math.max(100, Math.round(clip.width)),
          height: Math.max(100, Math.round(clip.height)),
          scale: 1
        }
      });
      const data = screenshot.result?.data;
      if (!data) continue;
      const imagePath = path.join(outputDir, `page-${String(index + 1).padStart(2, "0")}-${String(clipIndex + 1).padStart(2, "0")}.png`);
      fs.writeFileSync(imagePath, Buffer.from(data, "base64"));
      paths.push(imagePath);
    }
  }

  return {
    paths,
    metas,
    firstMeta,
    range,
    requiredPages,
    capturedPages: metas.length,
    complete: requiredPages <= maxPages && metas.length === requiredPages && paths.length >= requiredPages
  };
}

async function getVisibleDocumentClips(socket) {
  const result = await socket.send("Runtime.evaluate", {
    expression: `(${function findClips() {
      function rectOf(element) {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          bottom: rect.bottom,
          right: rect.right
        };
      }
      function isVisibleRect(rect) {
        return rect.width >= 520
          && rect.height >= 180
          && rect.right > 360
          && rect.left < window.innerWidth - 80
          && rect.bottom > 280
          && rect.top < window.innerHeight - 60;
      }

      const visualElements = [...document.querySelectorAll("img,canvas,svg")]
        .map(rectOf)
        .filter(isVisibleRect)
        .map((rect) => ({
          x: Math.max(rect.x, 330 + window.scrollX),
          y: Math.max(rect.y, 280 + window.scrollY),
          width: Math.min(rect.width, window.innerWidth - Math.max(rect.left, 330) - 40),
          height: Math.min(rect.height, window.innerHeight - Math.max(rect.top, 280) - 80),
          source: "visual"
        }))
        .filter((rect) => rect.width >= 520 && rect.height >= 180)
        .sort((a, b) => (b.width * b.height) - (a.width * a.height));

      if (visualElements.length) return visualElements.slice(0, 1);

      return [{
        x: 330 + window.scrollX,
        y: 300 + window.scrollY,
        width: Math.max(600, window.innerWidth - 390),
        height: Math.max(500, window.innerHeight - 380),
        source: "content-fallback"
      }];
    }.toString()})()`,
    returnByValue: true
  });
  const clips = result.result?.result?.value || [];
  return clips.length ? clips : [{ x: 330, y: 300, width: 900, height: 900, source: "fallback" }];
}

async function getScrollMeta(socket, targetTop) {
  const result = await socket.send("Runtime.evaluate", {
    expression: `(${function measureAndScroll(top) {
      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 300 && rect.height > 300 && style.visibility !== "hidden" && style.display !== "none";
      }

      const candidates = [document.scrollingElement, document.documentElement, document.body, ...document.querySelectorAll("main,section,article,div")]
        .filter(Boolean)
        .filter((element, index, list) => list.indexOf(element) === index)
        .filter((element) => element.scrollHeight > element.clientHeight + 200 && isVisible(element))
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      const element = candidates[0] || document.scrollingElement || document.documentElement;
      if (typeof top === "number") {
        if (element === document.scrollingElement || element === document.documentElement || element === document.body) {
          window.scrollTo(0, top);
        } else {
          element.scrollTop = top;
        }
      }
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        id: element.id || "",
        className: String(element.className || "").slice(0, 120),
        scrollTop: Math.round(element.scrollTop || window.scrollY || 0),
        scrollHeight: Math.round(element.scrollHeight || document.documentElement.scrollHeight || 0),
        clientHeight: Math.round(element.clientHeight || window.innerHeight || 0),
        rectTop: Math.round(rect.top),
        rectHeight: Math.round(rect.height)
      };
    }.toString()})(${targetTop === null ? "null" : Number(targetTop)})`,
    returnByValue: true
  });
  return result.result?.result?.value || { scrollTop: 0, scrollHeight: 0, clientHeight: 1600 };
}

async function ensureBrowser(url, port) {
  const status = await getStatus(port);
  if (status.running) return;
  openBrowser(url, port);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const next = await getStatus(port);
    if (next.running) return;
    await sleep(300);
  }
  throw new Error("浏览器调试端口未启动，请先运行 open。");
}

async function findOrOpenPage(url, port) {
  const pages = await getJson(`http://127.0.0.1:${port}/json`);
  const page = pages.find((item) => item.type === "page" && /kdocs\.cn/.test(item.url));
  if (page) return page;
  await requestJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, "PUT");
  await sleep(1500);
  const nextPages = await getJson(`http://127.0.0.1:${port}/json`);
  const nextPage = nextPages.find((item) => item.type === "page" && /kdocs\.cn/.test(item.url));
  if (!nextPage) throw new Error("未找到 kdocs 页面。");
  return nextPage;
}

function getJson(url) {
  return requestJson(url, "GET");
}

function requestJson(url, method) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpSocket {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => {
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
  }

  static connect(webSocketUrl) {
    const parsed = new URL(webSocketUrl);
    const key = crypto.randomBytes(16).toString("base64");

    return new Promise((resolve, reject) => {
      const socket = net.connect(Number(parsed.port || 80), parsed.hostname, () => {
        socket.write([
          `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
          `Host: ${parsed.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          ""
        ].join("\r\n"));
      });

      let handshake = Buffer.alloc(0);
      const onHandshake = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const marker = handshake.indexOf("\r\n\r\n");
        if (marker === -1) return;
        const header = handshake.slice(0, marker).toString("utf8");
        if (!/^HTTP\/1\.1 101/.test(header)) {
          reject(new Error(`WebSocket handshake failed: ${header.split("\r\n")[0]}`));
          socket.destroy();
          return;
        }
        socket.off("data", onHandshake);
        const cdp = new CdpSocket(socket);
        const rest = handshake.slice(marker + 4);
        if (rest.length) cdp.onData(rest);
        resolve(cdp);
      };

      socket.on("data", onHandshake);
      socket.on("error", reject);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    this.socket.write(encodeFrame(Buffer.from(payload, "utf8")));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const decoded = decodeFrame(this.buffer);
      if (!decoded) break;
      this.buffer = this.buffer.slice(decoded.consumed);
      if (!decoded.payload.length) continue;
      const message = JSON.parse(decoded.payload.toString("utf8"));
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        entry.resolve(message);
      }
    }
  }

  close() {
    this.socket.end();
  }
}

function encodeFrame(payload) {
  const length = payload.length;
  const header = [];
  header.push(0x81);
  if (length < 126) {
    header.push(0x80 | length);
  } else if (length < 65536) {
    header.push(0x80 | 126, (length >> 8) & 255, length & 255);
  } else {
    throw new Error("CDP frame too large");
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([Buffer.from(header), mask, masked]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let offset = 2;
  let length = buffer[1] & 0x7f;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0) throw new Error("WebSocket frame is too large");
    length = low;
    offset += 8;
  }
  const masked = Boolean(buffer[1] & 0x80);
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.slice(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index] ^ mask[index % 4];
    }
  }
  if (opcode === 0x8) return { payload: Buffer.alloc(0), consumed: offset + length };
  return { payload, consumed: offset + length };
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
