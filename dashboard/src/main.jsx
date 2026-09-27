/**
 * main.jsx — dashboard entry point (Vite).
 *
 * Mounts the control-room React app (ControlRoomApp.jsx) into #root and
 * loads the global stylesheet. All real-data logic lives in the app and the
 * server modules; this file only boots the UI.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import ControlRoomEntry from "./ControlRoomApp.jsx";
import "./style.css";

createRoot(document.getElementById("root")).render(<ControlRoomEntry />);
