import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import { reactRouterPlugin } from "./react-router-plugin";

export default defineConfig(() => {
  return {
    plugins: [
      pluginReact(),
      reactRouterPlugin({
        ssr: true,
        buildDirectory: 'build',
        appDirectory: 'app',
        basename: '/',
      }),
    ],
  };
});

