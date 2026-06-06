import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./app/router";
import "./globals.css";

// No StrictMode: the terminal panes attach a pty + xterm in a mount effect and
// detach/dispose on unmount, with no idempotency guard — StrictMode's double-invoke
// would double-attach and leak the first xterm instance.
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
