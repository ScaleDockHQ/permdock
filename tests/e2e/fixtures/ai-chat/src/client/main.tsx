import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";

const root = document.querySelector("#root");
if (root !== null) {
  createRoot(root).render(<App />);
}
