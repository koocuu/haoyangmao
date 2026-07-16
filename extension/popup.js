const APP_URL = "file:///D:/AS/Projects/haoyangmao/index.html";

const pageTitle = document.querySelector("#pageTitle");
const payloadInput = document.querySelector("#payload");
const sendBtn = document.querySelector("#sendBtn");
const hint = document.querySelector("#hint");

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const selection = await readSelection(tab.id);
  const payload = [
    tab.title || "",
    tab.url || "",
    selection || ""
  ].filter(Boolean).join("\n");

  pageTitle.textContent = tab.title || "当前页面";
  payloadInput.value = payload;
}

sendBtn.addEventListener("click", async () => {
  const lead = payloadInput.value.trim();
  if (!lead) {
    hint.textContent = "没有可发送的内容。";
    return;
  }
  const url = `${APP_URL}?source=extension&auto=1&lead=${encodeURIComponent(lead)}`;
  await chrome.tabs.create({ url });
  hint.textContent = "已发送。";
});

async function readSelection(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.getSelection().toString()
    });
    return result && result.result;
  } catch (error) {
    return "";
  }
}
