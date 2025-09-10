// chatboard.js

// ---- CONFIG ----
const ENV_ID = "https://twikoo-cloudflare.ertertertet07.workers.dev"; // your Worker URL
const LANG = "en";                                                     // UI language

// ---- INIT TWIKOO ----
twikoo.init({
  envId: ENV_ID,
  el: "#tcomment",
  lang: LANG
});

// ---- UTIL: file -> dataURL ----
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ---- CALL WORKER: UPLOAD_IMAGE ----
async function uploadViaTwikooWorker(file) {
  const photo = await fileToDataURL(file);
  const res = await fetch(ENV_ID, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "UPLOAD_IMAGE", photo })
  });
  const json = await res.json();
  if (json.code === 0 && json.data && json.data.url) return json.data.url;
  throw new Error(json.err || "Image upload failed");
}

// ---- SMALL UI: floating upload button ----
(function addUploadButton() {
  const btn = document.createElement("button");
  btn.textContent = "Upload image";
  Object.assign(btn.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    padding: "10px 14px",
    borderRadius: "8px",
    border: "none",
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    background: "#222",
    color: "#fff",
    cursor: "pointer",
    zIndex: 9999
  });

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.style.display = "none";

  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "Uploading...";
    try {
      const url = await uploadViaTwikooWorker(file);
      // Try to find Twikoo textarea and insert Markdown image
      const ta =
        document.querySelector(".tk-input .el-textarea__inner") ||
        document.querySelector(".tk-editor textarea") ||
        document.querySelector("textarea");
      if (ta) {
        const insert = `![image](${url})`;
        const start = ta.selectionStart ?? ta.value.length;
        const end = ta.selectionEnd ?? ta.value.length;
        ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.focus();
      }
      alert("Uploaded!\n" + url);
    } catch (e) {
      alert("Upload failed:\n" + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
      input.value = "";
    }
  });

  document.body.appendChild(btn);
  document.body.appendChild(input);
})();
