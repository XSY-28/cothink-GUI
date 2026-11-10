const imageTypes = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"],
]);
const markdownTypes = [".md", ".markdown"];
const textTypes = [
  ".txt", ".json", ".csv", ".tsv", ".xml", ".yaml", ".yml", ".toml", ".ini", ".log",
  ".js", ".ts", ".jsx", ".tsx", ".css", ".html", ".py", ".sh", ".rs", ".go", ".c",
  ".h", ".java", ".sql", ".tex", ".diff", ".patch",
];
const extension = path => {
  const name = path.split(/[\\/]/).at(-1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};

export const materialExtensions = [...imageTypes.keys(), ...markdownTypes, ...textTypes];

export function materialType(path, browserType) {
  const ext = extension(path);
  if (imageTypes.has(ext)) return imageTypes.get(ext);
  if (markdownTypes.includes(ext)) return "text/markdown";
  if (textTypes.includes(ext) || browserType?.startsWith("text/")) return "text/plain";
  if (browserType === undefined) return ext ? null : "text/plain";
  return browserType;
}
