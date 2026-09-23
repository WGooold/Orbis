import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "node_modules/**",
      "agent/**",
      "android/**",
      // 本地草稿：一次性探测脚本，没有跟踪进 Git，clean checkout 里也不存在。
      // 不忽略的话本地 lint 会长期挂着几十个只有本机才看得见的错误，等于把这道门禁作废。
      ".scratch/**",
      ".artifacts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/relay/src/web/*.js"],
    languageOptions: { globals: {
      document: "readonly", window: "readonly", location: "readonly", navigator: "readonly", fetch: "readonly",
      URL: "readonly", AbortController: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly",
      clearInterval: "readonly", FormData: "readonly",
    } },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        WebSocket: "readonly",
      },
    },
  },
  {
    // 「先声明、只赋值一次、但在赋值之前就已经被闭包读」是回调式构造里的常见写法：
    // 回调必须先注册（构造时），真实对象才在之后造出来。这不是 prefer-const 指的情形；
    // 默认配置会把这种写法判成错误，而 relay 的部署 CI 把 lint 错误当门禁，会直接卡住发版。
    rules: {
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
  {
    files: ["packages/**/*.ts", "*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
