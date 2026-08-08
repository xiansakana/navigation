"use strict";

/** PicList 自动时间戳格式：YYYYMMDDHHmmssSSS，如 202608081950112.png */
function formatStamp(date) {
  const pad = (n, w) => String(n).padStart(w, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1, 2) +
    pad(date.getDate(), 2) +
    pad(date.getHours(), 2) +
    pad(date.getMinutes(), 2) +
    pad(date.getSeconds(), 2) +
    pad(date.getMilliseconds(), 3)
  );
}

module.exports = (ctx) => {
  const register = () => {
    ctx.helper.beforeUploadPlugins.register("picgo-plugin-datetime-rename", {
      handle(ctx) {
        const base = Date.now();
        ctx.output.forEach((item, index) => {
          item.fileName = formatStamp(new Date(base + index)) + item.extname;
        });
      },
    });
  };
  return {
    transformer: "picgo-plugin-datetime-rename",
    register,
  };
};
