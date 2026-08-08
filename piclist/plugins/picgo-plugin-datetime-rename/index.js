"use strict";

/** PicList 时间戳：YYYYMMDDHHmmss + 毫秒百位，如 202608081950112.png（15 位） */
function formatStamp(date) {
  const pad = (n, w) => String(n).padStart(w, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1, 2) +
    pad(date.getDate(), 2) +
    pad(date.getHours(), 2) +
    pad(date.getMinutes(), 2) +
    pad(date.getSeconds(), 2) +
    String(Math.floor(date.getMilliseconds() / 100))
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
