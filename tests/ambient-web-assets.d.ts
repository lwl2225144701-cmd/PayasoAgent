// 供根 `npx tsc --noEmit` 使用的 Web 资源模块声明。
//
// 背景：tests/ 下的前端套件会静态 import web/src 的模块做断言（既有惯例），
// 根 tsconfig 因此会连带编译被 import 到的 web 模块。这些模块里存在两类
// 只有 Vite 能解析的 import —— CSS Modules 与 `?url` 静态资源：
// 它们在 web/tsconfig.json 里靠 `vite/client` 类型声明解析，而 vite 只装在
// web/node_modules，根程序看不见。本文件补上等价声明，让根类型检查能覆盖
// 这些被测试触达的前端模块（jsx 选项见根 tsconfig 的 "jsx": "react-jsx"）。
//
// 只声明"非代码资源"的形态，不放松任何 src/ 的生产代码类型。

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*?url' {
  const src: string;
  export default src;
}
