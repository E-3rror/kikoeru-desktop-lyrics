(function () {
  "use strict";
  var api = window.desktopLyrics;
  var url = document.getElementById("url");
  var port = document.getElementById("port");
  var secret = document.getElementById("secret");
  var status = document.getElementById("status");
  var saveButton = document.getElementById("save");
  var copyButton = document.getElementById("copy");
  function setStatus(text, error) { status.textContent = text || ""; status.classList.toggle("error", Boolean(error)); }
  function copyAddress() {
    var value = url.value;
    if (!value) return;
    var copied = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(value)
      : Promise.resolve().then(function () {
        url.select();
        if (!document.execCommand("copy")) throw new Error("复制失败");
      });
    copied.then(function () { setStatus("地址已复制"); }).catch(function (error) { setStatus(error.message || "复制失败", true); });
  }
  function load() {
    api.getBridgeInfo().then(function (info) {
      url.value = "http://" + info.host + ":" + info.port;
      port.value = info.port;
      secret.value = info.secret || "";
    }).catch(function (error) { setStatus(error.message || "读取配置失败", true); });
  }
  saveButton.addEventListener("click", function () {
    if (saveButton.disabled) return;
    saveButton.disabled = true;
    setStatus("正在重启…");
    api.saveBridgeInfo({ port: Number(port.value), secret: secret.value }).then(function (result) {
      if (!result || !result.ok) { setStatus((result && result.error) || "保存失败", true); return; }
      url.value = "http://" + result.host + ":" + result.port; port.value = result.port; secret.value = result.secret || ""; setStatus("已生效");
    }).catch(function (error) { setStatus(error.message || "保存失败", true); }).finally(function () { saveButton.disabled = false; });
  });
  copyButton.addEventListener("click", copyAddress);
  url.addEventListener("click", copyAddress);
  load();
})();
