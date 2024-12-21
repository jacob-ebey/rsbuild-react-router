import { isAbsolute, resolve, relative } from 'pathe';
import type { Config } from '@react-router/dev/config';
import type {  RouteConfigEntry } from '@react-router/dev/routes';
import type { RsbuildPlugin, Rspack } from '@rsbuild/core';
import { RspackVirtualModulePlugin } from 'rspack-plugin-virtual-module';
import * as esbuild from 'esbuild';
import { $ } from 'execa';
import { createJiti } from 'jiti';
import jsesc from 'jsesc';
import type { BabelTypes, ParseResult } from './babel';
import { traverse, t, parse, generate } from './babel';
import {
  toFunctionExpression,
  combineURLs,
  createRouteId,
  generateWithProps,
  removeExports,
} from './plugin-utils';

type BabelNodePath<T = any> = {
  node: T;
  scope: {
    generateUidIdentifier(name: string): BabelTypes.Identifier;
  };
  get(key: string): BabelNodePath;
  isExpression(): boolean;
  isFunctionDeclaration(): boolean;
  isExportDefaultDeclaration(): boolean;
  isExportNamedDeclaration(): boolean;
  isVariableDeclaration(): boolean;
  isIdentifier(): boolean;
  replaceWith(node: BabelTypes.Node): void;
  forEach(callback: (path: BabelNodePath) => void): void;
};

export type PluginOptions = {
  /**
   * Whether to enable Server-Side Rendering (SSR) support.
   * @default true
   */
  ssr?: boolean;
  /**
   * Build directory for output files
   * @default 'build'
   */
  buildDirectory?: string;
  /**
   * Application source directory
   * @default 'app'
   */
  appDirectory?: string;
  /**
   * Base URL path
   * @default '/'
   */
  basename?: string;
};

export const PLUGIN_NAME = 'rsbuild:react-router';

export const SERVER_ONLY_ROUTE_EXPORTS = ['loader', 'action', 'headers'];
export const CLIENT_ROUTE_EXPORTS = [
  'clientAction',
  'clientLoader',
  'default',
  'ErrorBoundary',
  'handle',
  'HydrateFallback',
  'Layout',
  'links',
  'meta',
  'shouldRevalidate',
];
export const NAMED_COMPONENT_EXPORTS = ['HydrateFallback', 'ErrorBoundary'];

export type Route = {
  id: string;
  parentId?: string;
  file: string;
  path?: string;
  index?: boolean;
  caseSensitive?: boolean;
  children?: Route[];
};

export type RouteManifestItem = Omit<Route, 'file' | 'children'> & {
  module: string;
  hasAction: boolean;
  hasLoader: boolean;
  hasClientAction: boolean;
  hasClientLoader: boolean;
  hasErrorBoundary: boolean;
  imports: string[];
  css: string[];
};

export const reactRouterPlugin = (
  options: PluginOptions = {},
): RsbuildPlugin => ({
  name: PLUGIN_NAME,

  async setup(api) {
    const defaultOptions = {
      ssr: true,
      buildDirectory: 'build',
      appDirectory: 'app',
      basename: '/',
    };

    const finalOptions = {
      ...defaultOptions,
      ...options,
    };

    // Run typegen on build/dev
    api.onBeforeStartDevServer(async () => {
      $`npx --yes react-router typegen --watch`;
    });

    api.onBeforeBuild(async () => {
      await $`npx --yes react-router typegen`;
    });

    const jiti = createJiti(process.cwd());

    // Read the react-router.config.ts file first
    const {
      appDirectory = finalOptions.appDirectory,
      basename = finalOptions.basename,
      buildDirectory = finalOptions.buildDirectory,
      ssr = finalOptions.ssr,
    } = await jiti
      .import<Config>('./react-router.config.ts', {
        default: true,
      })
      .catch(() => {
        console.error(
          'No react-router.config.ts found, using default configuration.',
        );
        return {} as Config;
      });

    // Update finalOptions with config values
    finalOptions.appDirectory = appDirectory;
    finalOptions.basename = basename;
    finalOptions.buildDirectory = buildDirectory;
    finalOptions.ssr = ssr;

    // Then read the routes
    const routeConfig = await jiti
      .import<RouteConfigEntry[]>(
        resolve(finalOptions.appDirectory, 'routes.ts'),
        {
          default: true,
        },
      )
      .catch(() => {
        console.error('No routes.ts found in app directory.');
        return [] as RouteConfigEntry[];
      });

    const entryClientPath = resolve(
      finalOptions.appDirectory,
      'entry.client.tsx',
    );
    const entryServerPath = resolve(
      finalOptions.appDirectory,
      'entry.server.tsx',
    );
    const rootRouteFile = relative(
      finalOptions.appDirectory,
      resolve(finalOptions.appDirectory, 'root.tsx'),
    );

    const routes = {
      root: { path: '', id: 'root', file: rootRouteFile },
      ...configRoutesToRouteManifest(finalOptions.appDirectory, routeConfig),
    };

    const outputClientPath = resolve(finalOptions.buildDirectory, 'client');
    const assetsBuildDirectory = relative(process.cwd(), outputClientPath);

    let clientStats: Rspack.StatsCompilation | undefined;
    api.onAfterEnvironmentCompile(({ stats, environment }) => {
      if (environment.name === 'web') {
        clientStats = stats?.toJson();
      }
    });

    // Add route transformation
    api.transform(
      {
        resourceQuery: /\?react-router-route/,
      },
      async args => {
        let code = (
          await esbuild.transform(args.code, {
            jsx: 'automatic',
            format: 'esm',
            platform: 'neutral',
            loader: args.resourcePath.endsWith('x') ? 'tsx' : 'ts',
          })
        ).code;

        const defaultExportMatch = code.match(
          /\n\s{0,}([\w\d_]+)\sas default,?/,
        );
        if (
          defaultExportMatch &&
          typeof defaultExportMatch.index === 'number'
        ) {
          code =
            code.slice(0, defaultExportMatch.index) +
            code.slice(defaultExportMatch.index + defaultExportMatch[0].length);
          code += `\nexport default ${defaultExportMatch[1]};`;
        }

        const ast = parse(code, { sourceType: 'module' });
        if (args.environment.name === 'web') {
          removeExports(ast, SERVER_ONLY_ROUTE_EXPORTS);
        }
        transformRoute(ast);

        return generate(ast, {
          sourceMaps: true,
          filename: args.resource,
          sourceFileName: args.resourcePath,
        });
      },
    );

    // Add transform to handle react-router development imports
    api.transform(
        { test: /react-router\/dist\/(development|production)\/index/ },
      ({ code }) => {
        // if (code.match(/await import/)) {
        //   debugger;
        // }
        // Replace the dynamic import pattern
        let newCode = code;
          newCode = code.replace(
            /await import \(/g,
            'await __webpack_require__.e(',
          );
        return newCode;
      },
    );

    // Create virtual modules for React Router
    const vmodPlugin = new RspackVirtualModulePlugin({
      'virtual/react-router/browser-manifest': 'export default {};',
      'virtual/react-router/server-manifest': 'export default {};',
      'virtual/react-router/server-build': generateServerBuild(routes, {
        entryServerPath,
        assetsBuildDirectory,
        basename: finalOptions.basename,
        appDirectory: finalOptions.appDirectory,
        ssr: finalOptions.ssr,
      }),
      'virtual/react-router/client-build': generateClientBuild(routes, {
        entryClientPath,
        basename: finalOptions.basename,
        appDirectory: finalOptions.appDirectory,
      }),
      'virtual/react-router/with-props': generateWithProps(),
    });

    // Modify Rsbuild config
    api.modifyRsbuildConfig(async (config, { mergeRsbuildConfig }) => {
      return mergeRsbuildConfig(config, {
        output: {
          assetPrefix: '/',
        },
        dev: {
          writeToDisk: true,
        },
        tools: {
          rspack: {
            plugins: [vmodPlugin],
          },
        },
        environments: {
          web: {
            source: {
              entry: {
                'entry.client': 'virtual/react-router/client-build',
                'virtual/react-router/browser-manifest':
                'virtual/react-router/browser-manifest',
              },
            },
            output: {
              distPath: {
                root: outputClientPath,
              },
            },
            tools: {
              rspack: {
                name: 'web',
                devtool: false,
                experiments: {
                  outputModule: true,
                },
                externalsType: 'module',
                output: {
                  chunkFormat: 'module',
                  chunkLoading: 'import',
                  workerChunkLoading: 'import',
                  wasmLoading: 'fetch',
                  library: { type: 'module' },
                  module: true,
                },
                optimization: {
                  runtimeChunk: 'single',
                },
              },
            },
          },
          node: {
            source: {
              entry: {
                app: './server/app.ts',
                'entry.server': entryServerPath,
              },
            },
            output: {
              distPath: {
                root: resolve(finalOptions.buildDirectory, 'server'),
              },
              target: 'node',
            },
            tools: {
              rspack: {
                externals: ['express'],
                dependencies: ['web'],
              },
            },
          },
        },
      });
    });

    // Add environment-specific modifications
    api.modifyEnvironmentConfig(async (config, { name, mergeEnvironmentConfig }) => {
      if (name === 'web') {
        return mergeEnvironmentConfig(config, {
          tools: {
            rspack: (rspackConfig) => {
              if (rspackConfig.plugins) {
                rspackConfig.plugins.push({
                  apply(compiler: Rspack.Compiler) {
                    compiler.hooks.emit.tapAsync('ModifyBrowserManifest', async (compilation: Rspack.Compilation, callback) => {
                      const stats = compilation.getStats().toJson({modules: false, reasons: false});
                      const manifest = await getReactRouterManifestForDev(
                        routes,
                        finalOptions,
                        stats
                      );

                      const manifestPath = 'static/js/virtual/react-router/browser-manifest.js';
                      const manifestContent = `window.__reactRouterManifest=${jsesc(manifest, { es6: true })};`;

                      if (compilation.assets[manifestPath]) {
                        const originalSource = compilation.assets[manifestPath].source().toString();
                        const newSource = originalSource.replace(
                          /["'`]PLACEHOLDER["'`]/,
                          jsesc(manifest, { es6: true })
                        );
                        compilation.assets[manifestPath] = {
                          source: () => newSource,
                          size: () => newSource.length,
                          map: () => ({
                            version: 3,
                            sources: [manifestPath],
                            names: [],
                            mappings: '',
                            file: manifestPath,
                            sourcesContent: [newSource]
                          }),
                          sourceAndMap: () => ({
                            source: newSource,
                            map: {
                              version: 3,
                              sources: [manifestPath],
                              names: [],
                              mappings: '',
                              file: manifestPath,
                              sourcesContent: [newSource]
                            }
                          }),
                          updateHash: (hash) => hash.update(newSource),
                          buffer: () => Buffer.from(newSource)
                        };
                      }
                      callback();
                    });
                  }
                });
              }
              return rspackConfig;
            },
          },
        });
      }
      return config;
    });

    // Add manifest transformations
    api.transform(
      {
        test: /virtual\/react-router\/(browser|server)-manifest/,
      },
      async args => {
        // For browser manifest, return a placeholder that will be modified by the plugin
        if (args.environment.name === 'web') {
          return {
            code: `window.__reactRouterManifest = "PLACEHOLDER";`,
          };
        }

        // For server manifest, use the clientStats as before
        const manifest = await getReactRouterManifestForDev(
          routes,
          finalOptions,
          clientStats
        );
        return {
          code: `export default ${jsesc(manifest, { es6: true })};`,
        };
      },
    );
  },
});

// Helper functions
function configRoutesToRouteManifest(
  appDirectory: string,
  routes: RouteConfigEntry[],
  rootId = 'root',
) {
  const routeManifest: Record<string, Route> = {};

  function walk(route: RouteConfigEntry, parentId: string) {
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

    if (routeManifest.hasOwnProperty(id)) {
      throw new Error(
        `Unable to define routes with duplicate route id: "${id}"`,
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

async function getReactRouterManifestForDev(
  routes: Record<string, Route>,
  options: PluginOptions,
  clientStats?: Rspack.StatsCompilation,
) {
  const result: Record<string, RouteManifestItem> = {};
  for (const [key, route] of Object.entries(routes)) {
    const assets = clientStats?.assetsByChunkName?.[route.id];
    const jsAssets = assets?.filter(asset => asset.endsWith('.js')) || [];
    const cssAssets = assets?.filter(asset => asset.endsWith('.css')) || [];
    result[key] = {
      id: route.id,
      parentId: route.parentId,
      path: route.path,
      index: route.index,
      caseSensitive: route.caseSensitive,
      module: combineURLs(
        '/static/js/async/',
        `${route.file.slice(0, route.file.lastIndexOf('.'))}.js`,
      ),
      hasAction: false,
      hasLoader: route.id === 'routes/home',
      hasClientAction: false,
      hasClientLoader: true,
      hasErrorBoundary: route.id === 'root',
      imports: jsAssets.map(asset => combineURLs('/', asset)),
      css: cssAssets.map(asset => combineURLs('/', asset)),
    };
  }

  const entryAssets = clientStats?.assetsByChunkName?.['entry.client'];
  const entryJsAssets = entryAssets?.filter(asset => asset.endsWith('.js')) || [];
  const entryCssAssets = entryAssets?.filter(asset => asset.endsWith('.css')) || [];

  return {
    version: String(Math.random()),
    url: '/static/js/virtual/react-router/browser-manifest.js',
    entry: {
      module: '/static/js/entry.client.js',
      imports: entryJsAssets.map(asset => combineURLs('/', asset)),
      css: entryCssAssets.map(asset => combineURLs('/', asset)),
    },
    routes: result,
  };
}

/**
 * Generates the server build module content
 * @param routes The route manifest
 * @param options Build options
 * @returns The generated module content as a string
 */
function generateServerBuild(
  routes: Record<string, Route>,
  options: {
    entryServerPath: string;
    assetsBuildDirectory: string;
    basename: string;
    appDirectory: string;
    ssr: boolean;
  },
): string {
  return `
    import * as entryServer from ${JSON.stringify(options.entryServerPath)};
    export { default as assets } from "virtual/react-router/server-manifest";
    export const assetsBuildDirectory = ${JSON.stringify(
      options.assetsBuildDirectory,
    )};
    export const basename = ${JSON.stringify(options.basename)};
    export const future = ${JSON.stringify({})};
    export const isSpaMode = ${!options.ssr};
    export const publicPath = "/";
    export const entry = { module: entryServer };

    const routeModules = {
      ${Object.keys(routes)
        .map((key) => {
          const route = routes[key];
          return `${JSON.stringify(key)}: () => import(
            /* webpackChunkName: ${JSON.stringify(route.id)} */
            ${JSON.stringify(`${resolve(options.appDirectory, route.file)}?react-router-route`)}
          )`;
        })
        .join(',\n  ')}
    };

    const createRouteProxy = (routeKey, id) => {
      let modulePromise;
      let loadedModule;
      const getModule = () => {
        if (!modulePromise) {
          modulePromise = routeModules[routeKey]().then(mod => {
            loadedModule = mod;
            return mod;
          });
        }
        return modulePromise;
      };

      return new Proxy({}, {
        get(target, prop) {
          if (prop === 'loader') {
            return async (...args) => {
              const mod = await getModule();
              if (mod.loader) {
                const result = await mod.loader(...args);
                return result;
              }
              return null;
            };
          }
          // Meta is synchronous but depends on loader data
          if (prop === 'meta') {
            return (...args) => {
              // If module is not loaded yet, return empty array
              // The loader will have triggered the load
              if (!loadedModule) {
                return [];
              }
              if (loadedModule.meta) {
                return loadedModule.meta(...args);
              }
              return [];
            };
          }
          // For other props, if module is loaded return sync, otherwise return promise
          if (loadedModule) {
            return loadedModule[prop];
          }
          return getModule().then(mod => mod[prop]);
        }
      });
    };

    export const routes = {
      ${Object.keys(routes)
        .map((key) => {
          const route = routes[key];
          return `${JSON.stringify(key)}: {
            id: ${JSON.stringify(route.id)},
            parentId: ${JSON.stringify(route.parentId)},
            path: ${JSON.stringify(route.path)},
            index: ${JSON.stringify(route.index)},
            caseSensitive: ${JSON.stringify(route.caseSensitive)},
            module: createRouteProxy(${JSON.stringify(key)}, ${JSON.stringify(route.id)})
          }`;
        })
        .join(',\n  ')}
    };
  `;
}

function generateClientBuild(
  routes: Record<string, Route>,
  options: {
    entryClientPath: string;
    appDirectory: string;
    basename: string;
  },
): string {
  return `
    import * as entryClient from ${JSON.stringify(options.entryClientPath)};

    const routeModules = {
      ${Object.keys(routes)
        .map((key) => {
          const route = routes[key];
          return `${JSON.stringify(key)}: () => import(
            /* webpackChunkName: ${JSON.stringify(route.id)} */
            ${JSON.stringify(`${resolve(options.appDirectory, route.file)}?react-router-route`)}
          )`;
        })
        .join(',\n  ')}
    };

    const createRouteProxy = (routeKey, id) => {
      let modulePromise;
      let loadedModule;
      const getModule = () => {
        if (!modulePromise) {
          modulePromise = routeModules[routeKey]().then(mod => {
            loadedModule = mod;
            return mod;
          });
        }
        return modulePromise;
      };

      return new Proxy({}, {
        get(target, prop) {
          if (prop === 'clientLoader') {
            return async (...args) => {
              const mod = await getModule();
              if (mod.clientLoader) {
                const result = await mod.clientLoader(...args);
                return result;
              }
              return null;
            };
          }
          if (prop === 'clientAction') {
            return async (...args) => {
              const mod = await getModule();
              if (mod.clientAction) {
                const result = await mod.clientAction(...args);
                return result;
              }
              return null;
            };
          }
          // For other props, if module is loaded return sync, otherwise return promise
          if (loadedModule) {
          console.log(target, prop);
            return loadedModule[prop];
          }
          return getModule().then(mod => mod[prop]);
        }
      });
    };

    export const routes = {
      ${Object.keys(routes)
        .map((key) => {
          const route = routes[key];
          return `${JSON.stringify(key)}: {
            id: ${JSON.stringify(route.id)},
            parentId: ${JSON.stringify(route.parentId)},
            path: ${JSON.stringify(route.path)},
            index: ${JSON.stringify(route.index)},
            caseSensitive: ${JSON.stringify(route.caseSensitive)},
            module: createRouteProxy(${JSON.stringify(key)}, ${JSON.stringify(route.id)})
          }`;
        })
        .join(',\n  ')}
    };

    export { routeModules };
  `;
}

export const transformRoute = (ast: ParseResult<BabelTypes.File>) => {
  const hocs: Array<[string, BabelTypes.Identifier]> = [];
  function getHocUid(path: BabelNodePath<BabelTypes.Node>, hocName: string) {
    const uid = path.scope.generateUidIdentifier(hocName);
    hocs.push([hocName, uid]);
    return uid;
  }

  traverse(ast, {
    ExportDeclaration(path: BabelNodePath<BabelTypes.ExportDeclaration>) {
      if (path.isExportDefaultDeclaration()) {
        const declaration = path.get('declaration');
        // prettier-ignore
        const expr =
              declaration.isExpression() ? declaration.node :
                  declaration.isFunctionDeclaration() ? toFunctionExpression(declaration.node) :
                      undefined
        if (expr) {
          const uid = getHocUid(path, 'withComponentProps');
          declaration.replaceWith(t.callExpression(uid, [expr]));
        }
        return;
      }

      if (path.isExportNamedDeclaration()) {
        const decl = path.get('declaration');

        if (decl.isVariableDeclaration()) {
          // biome-ignore lint/complexity/noForEach: <explanation>
          decl.get('declarations').forEach((varDeclarator: BabelNodePath<BabelTypes.VariableDeclarator>) => {
            const id = varDeclarator.get('id');
            const init = varDeclarator.get('init');
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
            t.variableDeclaration('const', [
              t.variableDeclarator(
                t.identifier(name),
                t.callExpression(uid, [toFunctionExpression(decl.node)]),
              ),
            ]),
          );
        }
      }
    },
  });

  if (hocs.length > 0) {
    ast.program.body.unshift(
      t.importDeclaration(
        hocs.map(([name, identifier]) =>
          t.importSpecifier(identifier, t.identifier(name)),
        ),
        t.stringLiteral('virtual/react-router/with-props'),
      ),
    );
  }
};
