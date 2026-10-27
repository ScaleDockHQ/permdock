import { defineConfig } from "oxlint";
import reactNative from "ultracite/oxlint/react-native";

// @boundaries-ignore the shared lint config lives at the repository root
import { core, example, react } from "../../../oxlint.config.ts";

export default defineConfig({ extends: [core, react, reactNative, example] });
