/** Vite's `?raw` import, used to test against the real `index.html` markup. */
declare module "*.html?raw" {
  const contents: string;
  export default contents;
}
