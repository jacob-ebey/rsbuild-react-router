import { isAbsolute, normalize, resolve, relative } from "pathe";

import type { Config } from "@react-router/dev/config";
import type { RouteConfig } from "@react-router/dev/routes";
import {
  defineConfig,
  type RsbuildConfig,
  type RsbuildPluginAPI,
} from "@rsbuild/core";
import {} from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";
import {
  findReferencedIdentifiers,
  deadCodeElimination,
} from "babel-dead-code-elimination";
import * as esbuild from "esbuild";
import { $ } from "execa";
import { createJiti } from "jiti";
import jsesc from "jsesc";
import { RspackVirtualModulePlugin } from "rspack-plugin-virtual-module";

import type { Babel, NodePath, ParseResult } from "./babel";
import { traverse, t, parse, generate } from "./babel";

export default defineConfig(async ({ command }) => {
  if (command === "build") {
    await $`npx --yes react-router typegen`;
  } else {
    $`npx --yes react-router typegen --watch`;
  }

  const jiti = createJiti(process.cwd());
  const {
    appDirectory = "app",
    basename = "/",
    buildDirectory = "build",
    buildEnd,
    future = {},
    prerender,
    presets,
    ssr = true,
  } = await jiti
    .import<Config>("./react-router.config.ts", {
      default: true,
    })
    .catch(() => {
      console.error(
        "No react-router.config.ts found, using default configuration."
      );
      return {} as Config;
    });

  if (buildEnd) {
    throw new Error("buildEnd is not supported right now.");
  }
  if (presets) {
    throw new Error("presets are not supported right now.");
  }
  if (!ssr) {
    throw new Error("ssr is required to be true right now.");
  }

  const entryClientPath = resolve(appDirectory, "entry.client.tsx");
  const entryServerPath = resolve(appDirectory, "entry.server.tsx");
  const rootRouteFile = relative(
    appDirectory,
    resolve(appDirectory, "root.tsx")
  );
  const routesPath = resolve(appDirectory, "routes.ts");

  const outputClientPath = resolve(buildDirectory, "client");
  const assetsBuildDirectory = relative(process.cwd(), outputClientPath);

  const routeConfig = await jiti.import<RouteConfig>(routesPath, {
    default: true,
  });

  const routes = {
    root: { path: "", id: "root", file: rootRouteFile },
    ...configRoutesToRouteManifest(appDirectory, routeConfig),
  } as Record<
    string,
    {
      path?: string;
      id: string;
      parentId?: string;
      file: string;
      index?: number;
      caseSensitive?: boolean;
    }
  >;
  // TODO: Get this from the final config options
  const publicPath = "/";

  let devManifest: any;
  const getReactRouterManifestForDev = async () => {
    const result: Record<string, unknown> = {};

    // let routeManifestExports = await getRouteManifestModuleExports(
    //   viteChildCompiler,
    //   ctx
    // );

    for (const [key, route] of Object.entries(routes)) {
      // const sourceExports = routeManifestExports[key];
      result[key] = {
        id: route.id,
        parentId: route.parentId,
        path: route.path,
        index: route.index,
        caseSensitive: route.caseSensitive,
        module: combineURLs(
          "/static/js/",
          `${route.file.slice(0, route.file.lastIndexOf("."))}.js`
        ),
        hasAction: false,
        hasLoader: route.id === "routes/home",
        hasClientAction: false,
        hasClientLoader: false,
        hasErrorBoundary: route.id === "root",
        // module: combineURLs(
        //   ctx.publicPath,
        //   resolveFileUrl(
        //     ctx,
        //     resolveRelativeRouteFilePath(route, ctx.reactRouterConfig)
        //   )
        // ),
        // hasAction: sourceExports.includes("action"),
        // hasLoader: sourceExports.includes("loader"),
        // hasClientAction: sourceExports.includes("clientAction"),
        // hasClientLoader: sourceExports.includes("clientLoader"),
        // hasErrorBoundary: sourceExports.includes("ErrorBoundary"),
        imports: [],
      };
    }

    // biome-ignore lint/suspicious/noAssignInExpressions: <explanation>
    return (devManifest = {
      version: String(Math.random()),
      url: "/static/js/virtual/react-router/browser-manifest.js",
      // hmr: {
      //   // runtime: combineURLs(ctx.publicPath, virtualInjectHmrRuntime.url),
      // },
      entry: {
        module: "/static/js/entry.client.js",
        imports: [],
      },
      routes: result,
    });
  };

  const vmodPlugin = new RspackVirtualModulePlugin({
    "virtual/react-router/browser-manifest": `window.__reactRouterManifest=${jsesc(
      await getReactRouterManifestForDev(),
      {
        es6: true,
      }
    )};`,
    "virtual/react-router/server-manifest": `export default ${jsesc(
      await getReactRouterManifestForDev(),
      {
        es6: true,
      }
    )};`,
    "virtual/react-router/server-build": `
      import * as entryServer from ${JSON.stringify(entryServerPath)};
      ${Object.keys(routes)
        .map((key, index) => {
          const route = routes[key];
          return `import * as route${index} from ${JSON.stringify(
            `${resolve(appDirectory, route.file)}?react-router-route`
          )};`;
        })
        .join("\n")}

      export { default as assets } from "virtual/react-router/server-manifest";
      export const assetsBuildDirectory = ${JSON.stringify(
        assetsBuildDirectory
      )};
      export const basename = ${JSON.stringify(basename)};
      export const future = ${JSON.stringify(future)};
      export const isSpaMode = ${!ssr && prerender == null};
      export const publicPath = ${JSON.stringify(publicPath)};
      export const entry = { module: entryServer };
      export const routes = {
        ${Object.keys(routes)
          .map((key, index) => {
            const route = routes[key];
            return `${JSON.stringify(key)}: {
          id: ${JSON.stringify(route.id)},
          parentId: ${JSON.stringify(route.parentId)},
          path: ${JSON.stringify(route.path)},
          index: ${JSON.stringify(route.index)},
          caseSensitive: ${JSON.stringify(route.caseSensitive)},
          module: route${index}
        }`;
          })
          .join(",\n  ")}
      };
    `,
    "virtual/react-router/with-props": `
      import { createElement as h } from "react";
      import { useActionData, useLoaderData, useMatches, useParams, useRouteError } from "react-router";

      export function withComponentProps(Component) {
        return function Wrapped() {
          const props = {
            params: useParams(),
            loaderData: useLoaderData(),
            actionData: useActionData(),
            matches: useMatches(),
          };
          return h(Component, props);
        };
      }

      export function withHydrateFallbackProps(HydrateFallback) {
        return function Wrapped() {
          const props = {
            params: useParams(),
          };
          return h(HydrateFallback, props);
        };
      }

      export function withErrorBoundaryProps(ErrorBoundary) {
        return function Wrapped() {
          const props = {
            params: useParams(),
            loaderData: useLoaderData(),
            actionData: useActionData(),
            error: useRouteError(),
          };
          return h(ErrorBoundary, props);
        };
      }
    `,
  });

  return {
    output: {
      assetPrefix: publicPath,
    },
    dev: {
      writeToDisk: true,
    },
    environments: {
      web: {
        source: {
          entry: {
            "entry.client": entryClientPath,
            "virtual/react-router/browser-manifest":
              "virtual/react-router/browser-manifest",
            ...Object.values(routes).reduce(
              (acc, route) =>
                Object.assign(acc, {
                  [route.file.slice(
                    0,
                    route.file.lastIndexOf(".")
                  )]: `${resolve(appDirectory, route.file)}?react-router-route`,
                }),
              {} as Record<string, string>
            ),
          },
        },
        output: {
          distPath: {
            root: outputClientPath,
          },
        },
        tools: {
          rspack: {
            devtool: false,
            plugins: [vmodPlugin],
            experiments: {
              outputModule: true,
            },
            externalsType: "module",
            output: {
              chunkFormat: "module",
              chunkLoading: "import",
              workerChunkLoading: "import",
              wasmLoading: "fetch",
              library: { type: "module" },
              module: true,
            },
            optimization: {
              runtimeChunk: "single",
            },
          },
        },
      },
      node: {
        source: {
          entry: {
            app: "./server/app.ts",
            "entry.server": entryServerPath,
          },
        },
        output: {
          distPath: {
            root: resolve(buildDirectory, "server"),
          },
          target: "node",
        },
        tools: {
          rspack: {
            plugins: [vmodPlugin],
            // This would be user config
            externals: ["express"],
          },
        },
      },
    },
    plugins: [
      pluginReact(),
      {
        name: "react-router:virtual",
        setup(api: RsbuildPluginAPI) {
          api.transform(
            {
              resourceQuery: /\?react-router-route/,
            },
            async (args) => {
              let code = (
                await esbuild.transform(args.code, {
                  jsx: "automatic",
                  format: "esm",
                  platform: "neutral",
                  loader: args.resourcePath.endsWith("x") ? "tsx" : "ts",
                })
              ).code;
              const defaultExportMatch = code.match(
                /\n\s{0,}([\w\d_]+)\sas default,?/
              );
              if (
                defaultExportMatch &&
                typeof defaultExportMatch.index === "number"
              ) {
                code =
                  code.slice(0, defaultExportMatch.index) +
                  code.slice(
                    defaultExportMatch.index + defaultExportMatch[0].length
                  );
                code += `\nexport default ${defaultExportMatch[1]};`;
              }

              console.log("TRANSFORMING", args.resource, defaultExportMatch);
              console.log(await import("@babel/plugin-transform-typescript"));

              const ast = parse(code, {
                sourceType: "module",
              });
              if (args.environment.name === "web") {
                removeExports(ast, SERVER_ONLY_ROUTE_EXPORTS);
              }
              transformRoute(ast);
              return generate(ast, {
                sourceMaps: true,
                filename: args.resource,
                sourceFileName: args.resourcePath,
              });
            }
          );
        },
      },
    ],
  } satisfies RsbuildConfig;
});

const SERVER_ONLY_ROUTE_EXPORTS = ["loader", "action", "headers"];
const CLIENT_ROUTE_EXPORTS = [
  "clientAction",
  "clientLoader",
  "default",
  "ErrorBoundary",
  "handle",
  "HydrateFallback",
  "Layout",
  "links",
  "meta",
  "shouldRevalidate",
];

function configRoutesToRouteManifest(
  appDirectory: string,
  routes: Awaited<RouteConfig>,
  rootId = "root"
) {
  const routeManifest: Record<string, unknown> = {};

  function walk(route: Awaited<RouteConfig>[number], parentId: string) {
    const id = route.id || createRouteId(route.file);
    const manifestItem = {
      id,
      parentId,
      file: isAbsolute(route.file)
        ? relative(appDirectory, route.file)
        : route.file,
      path: route.path,
      index: route.index,
      caseSensitive: route.caseSensitive,
    };

    // biome-ignore lint/suspicious/noPrototypeBuiltins: <explanation>
    if (routeManifest.hasOwnProperty(id)) {
      throw new Error(
        `Unable to define routes with duplicate route id: "${id}"`
      );
    }
    routeManifest[id] = manifestItem;

    if (route.children) {
      for (const child of route.children) {
        walk(child, id);
      }
    }
  }

  for (const route of routes) {
    walk(route, rootId);
  }

  return routeManifest;
}

function createRouteId(file: string) {
  return normalize(stripFileExtension(file));
}

function stripFileExtension(file: string) {
  return file.replace(/\.[a-z0-9]+$/i, "");
}

function combineURLs(baseURL: string, relativeURL: string) {
  return relativeURL
    ? `${baseURL.replace(/\/+$/, "")}/${relativeURL.replace(/^\/+/, "")}`
    : baseURL;
}

const NAMED_COMPONENT_EXPORTS = ["HydrateFallback", "ErrorBoundary"];

const transformRoute = (ast: ParseResult<Babel.File>) => {
  const hocs: Array<[string, Babel.Identifier]> = [];
  function getHocUid(path: NodePath, hocName: string) {
    const uid = path.scope.generateUidIdentifier(hocName);
    hocs.push([hocName, uid]);
    return uid;
  }

  traverse(ast, {
    ExportDeclaration(path) {
      if (path.isExportDefaultDeclaration()) {
        const declaration = path.get("declaration");
        // prettier-ignore
        const expr =
          declaration.isExpression() ? declaration.node :
          declaration.isFunctionDeclaration() ? toFunctionExpression(declaration.node) :
          undefined
        if (expr) {
          const uid = getHocUid(path, "withComponentProps");
          declaration.replaceWith(t.callExpression(uid, [expr]));
        }
        return;
      }

      if (path.isExportNamedDeclaration()) {
        const decl = path.get("declaration");

        if (decl.isVariableDeclaration()) {
          // biome-ignore lint/complexity/noForEach: <explanation>
          decl.get("declarations").forEach((varDeclarator) => {
            const id = varDeclarator.get("id");
            const init = varDeclarator.get("init");
            const expr = init.node;
            if (!expr) return;
            if (!id.isIdentifier()) return;
            const { name } = id.node;
            if (!NAMED_COMPONENT_EXPORTS.includes(name)) return;

            const uid = getHocUid(path, `with${name}Props`);
            init.replaceWith(t.callExpression(uid, [expr]));
          });
          return;
        }

        if (decl.isFunctionDeclaration()) {
          const { id } = decl.node;
          if (!id) return;
          const { name } = id;
          if (!NAMED_COMPONENT_EXPORTS.includes(name)) return;

          const uid = getHocUid(path, `with${name}Props`);
          decl.replaceWith(
            t.variableDeclaration("const", [
              t.variableDeclarator(
                t.identifier(name),
                t.callExpression(uid, [toFunctionExpression(decl.node)])
              ),
            ])
          );
        }
      }
    },
  });

  if (hocs.length > 0) {
    ast.program.body.unshift(
      t.importDeclaration(
        hocs.map(([name, identifier]) =>
          t.importSpecifier(identifier, t.identifier(name))
        ),
        t.stringLiteral("virtual/react-router/with-props")
      )
    );
  }
};

function toFunctionExpression(decl: Babel.FunctionDeclaration) {
  return t.functionExpression(
    decl.id,
    decl.params,
    decl.body,
    decl.generator,
    decl.async
  );
}

const removeExports = (
  ast: ParseResult<Babel.File>,
  exportsToRemove: string[]
) => {
  const previouslyReferencedIdentifiers = findReferencedIdentifiers(ast);
  let exportsFiltered = false;
  const markedForRemoval = new Set<NodePath<Babel.Node>>();

  traverse(ast, {
    ExportDeclaration(path) {
      // export { foo };
      // export { bar } from "./module";
      if (path.node.type === "ExportNamedDeclaration") {
        if (path.node.specifiers.length) {
          path.node.specifiers = path.node.specifiers.filter((specifier) => {
            // Filter out individual specifiers
            if (
              specifier.type === "ExportSpecifier" &&
              specifier.exported.type === "Identifier"
            ) {
              if (exportsToRemove.includes(specifier.exported.name)) {
                exportsFiltered = true;
                return false;
              }
            }
            return true;
          });
          // Remove the entire export statement if all specifiers were removed
          if (path.node.specifiers.length === 0) {
            markedForRemoval.add(path);
          }
        }

        // export const foo = ...;
        // export const [ foo ] = ...;
        if (path.node.declaration?.type === "VariableDeclaration") {
          const declaration = path.node.declaration;
          declaration.declarations = declaration.declarations.filter(
            (declaration) => {
              // export const foo = ...;
              // export const foo = ..., bar = ...;
              if (
                declaration.id.type === "Identifier" &&
                exportsToRemove.includes(declaration.id.name)
              ) {
                // Filter out individual variables
                exportsFiltered = true;
                return false;
              }

              // export const [ foo ] = ...;
              // export const { foo } = ...;
              if (
                declaration.id.type === "ArrayPattern" ||
                declaration.id.type === "ObjectPattern"
              ) {
                // NOTE: These exports cannot be safely removed, so instead we
                // validate them to ensure that any exports that are intended to
                // be removed are not present
                validateDestructuredExports(declaration.id, exportsToRemove);
              }

              return true;
            }
          );
          // Remove the entire export statement if all variables were removed
          if (declaration.declarations.length === 0) {
            markedForRemoval.add(path);
          }
        }

        // export function foo() {}
        if (path.node.declaration?.type === "FunctionDeclaration") {
          const id = path.node.declaration.id;
          if (id && exportsToRemove.includes(id.name)) {
            markedForRemoval.add(path);
          }
        }

        // export class Foo() {}
        if (path.node.declaration?.type === "ClassDeclaration") {
          const id = path.node.declaration.id;
          if (id && exportsToRemove.includes(id.name)) {
            markedForRemoval.add(path);
          }
        }
      }

      // export default ...;
      if (
        path.node.type === "ExportDefaultDeclaration" &&
        exportsToRemove.includes("default")
      ) {
        markedForRemoval.add(path);
      }
    },
  });

  if (markedForRemoval.size > 0 || exportsFiltered) {
    for (const path of markedForRemoval) {
      path.remove();
    }

    // Run dead code elimination on any newly unreferenced identifiers
    deadCodeElimination(ast, previouslyReferencedIdentifiers);
  }
};

function validateDestructuredExports(
  id: Babel.ArrayPattern | Babel.ObjectPattern,
  exportsToRemove: string[]
) {
  if (id.type === "ArrayPattern") {
    for (const element of id.elements) {
      if (!element) {
        continue;
      }

      // [ foo ]
      if (
        element.type === "Identifier" &&
        exportsToRemove.includes(element.name)
      ) {
        throw invalidDestructureError(element.name);
      }

      // [ ...foo ]
      if (
        element.type === "RestElement" &&
        element.argument.type === "Identifier" &&
        exportsToRemove.includes(element.argument.name)
      ) {
        throw invalidDestructureError(element.argument.name);
      }

      // [ [...] ]
      // [ {...} ]
      if (element.type === "ArrayPattern" || element.type === "ObjectPattern") {
        validateDestructuredExports(element, exportsToRemove);
      }
    }
  }

  if (id.type === "ObjectPattern") {
    for (const property of id.properties) {
      if (!property) {
        continue;
      }

      if (
        property.type === "ObjectProperty" &&
        property.key.type === "Identifier"
      ) {
        // { foo }
        if (
          property.value.type === "Identifier" &&
          exportsToRemove.includes(property.value.name)
        ) {
          throw invalidDestructureError(property.value.name);
        }

        // { foo: [...] }
        // { foo: {...} }
        if (
          property.value.type === "ArrayPattern" ||
          property.value.type === "ObjectPattern"
        ) {
          validateDestructuredExports(property.value, exportsToRemove);
        }
      }

      // { ...foo }
      if (
        property.type === "RestElement" &&
        property.argument.type === "Identifier" &&
        exportsToRemove.includes(property.argument.name)
      ) {
        throw invalidDestructureError(property.argument.name);
      }
    }
  }
}

function invalidDestructureError(name: string) {
  return new Error(`Cannot remove destructured export "${name}"`);
}
