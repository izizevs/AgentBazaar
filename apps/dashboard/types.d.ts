// Allow CSS module imports
declare module '*.css' {
  const styles: Record<string, string>;
  export default styles;
}

// Allow SVG imports
declare module '*.svg' {
  const content: string;
  export default content;
}
