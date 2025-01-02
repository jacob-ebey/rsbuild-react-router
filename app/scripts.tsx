import * as React from 'react';
import {matchRoutes, DataRouter, UNSAFE_AssetsManifest, RouterState, UNSAFE_DataRouterContext, UNSAFE_DataRouterStateContext, UNSAFE_FrameworkContext} from "react-router";

let isHydrated = false;

export function isFogOfWarEnabled(isSpaMode: boolean) {
    return !isSpaMode;
}

function invariant(value: any, message?: string) {
    if (value === false || value === null || typeof value === "undefined") {
        console.error(
            "The following error is a bug in React Router; please open an issue! https://github.com/remix-run/react-router/issues/new/choose"
        );
        throw new Error(message);
    }
}

function createHtml(html: string): any {
    return { __html: html };
}

function getPartialManifest(
    manifest: UNSAFE_AssetsManifest,
    router: DataRouter
) {
    // Start with our matches for this pathname
    let routeIds = new Set(router.state.matches.map((m) => m.route.id));

    let segments = router.state.location.pathname.split("/").filter(Boolean);
    let paths: string[] = ["/"];

    // We've already matched to the last segment
    segments.pop();

    // Traverse each path for our parents and match in case they have pathless/index
    // children we need to include in the initial manifest
    while (segments.length > 0) {
        paths.push(`/${segments.join("/")}`);
        segments.pop();
    }

    paths.forEach((path) => {
        let matches = matchRoutes(router.routes, path, router.basename);
        if (matches) {
            matches.forEach((m) => routeIds.add(m.route.id));
        }
    });

    let initialRoutes = [...routeIds].reduce(
        (acc, id) => Object.assign(acc, { [id]: manifest.routes[id] }),
        {}
    );
    return {
        ...manifest,
        routes: initialRoutes,
    };
}


function getActiveMatches(
    matches: RouterState["matches"],
    errors: RouterState["errors"],
    isSpaMode: boolean
) {
    if (isSpaMode && !isHydrated) {
        return [matches[0]];
    }

    if (errors) {
        let errorIdx = matches.findIndex((m) => errors[m.route.id] !== undefined);
        return matches.slice(0, errorIdx + 1);
    }

    return matches;
}

export function useFrameworkContext(): any {
    let context = React.useContext(UNSAFE_FrameworkContext);
    invariant(
        context,
        "You must render this element inside a <HydratedRouter> element"
    );
    return context;
}

function useDataRouterContext(): any {
    let context = React.useContext(UNSAFE_DataRouterContext);
    invariant(
        context,
        "You must render this element inside a <DataRouterContext.Provider> element"
    );
    return context;
}

function useDataRouterStateContext(): any {
    let context = React.useContext(UNSAFE_DataRouterStateContext);
    invariant(
        context,
        "You must render this element inside a <DataRouterStateContext.Provider> element"
    );
    return context;
}

/**
 A couple common attributes:

 - `<Scripts crossOrigin>` for hosting your static assets on a different server than your app.
 - `<Scripts nonce>` to support a [content security policy for scripts](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/script-src) with [nonce-sources](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/Sources#sources) for your `<script>` tags.

 You cannot pass through attributes such as `async`, `defer`, `src`, `type`, `noModule` because they are managed by React Router internally.

 @category Types
 */
export type ScriptsProps = Omit<
    React.HTMLProps<HTMLScriptElement>,
    | "children"
    | "async"
    | "defer"
    | "src"
    | "type"
    | "noModule"
    | "dangerouslySetInnerHTML"
    | "suppressHydrationWarning"
>;

/**
 Renders the client runtime of your app. It should be rendered inside the `<body>` of the document.

 ```tsx
 import { Scripts } from "react-router";

 export default function Root() {
 return (
 <html>
 <head />
 <body>
 <Scripts />
 </body>
 </html>
 );
 }
 ```

 If server rendering, you can omit `<Scripts/>` and the app will work as a traditional web app without JavaScript, relying solely on HTML and browser behaviors.

 @category Components
 */
export function Scripts(props: ScriptsProps) {
    let { manifest, serverHandoffString, isSpaMode, renderMeta } =
        useFrameworkContext();
    let { router, static: isStatic, staticContext } = useDataRouterContext();
    let { matches: routerMatches } = useDataRouterStateContext();
    let enableFogOfWar = isFogOfWarEnabled(isSpaMode);

    // Let <ServerRouter> know that we hydrated and we should render the single
    // fetch streaming scripts
    if (renderMeta) {
        renderMeta.didRenderScripts = true;
    }

    let matches = getActiveMatches(routerMatches, null, isSpaMode);

    React.useEffect(() => {
        isHydrated = true;
    }, []);

    let initialScripts = React.useMemo(() => {
        let streamScript =
            "window.__reactRouterContext.stream = new ReadableStream({" +
            "start(controller){" +
            "window.__reactRouterContext.streamController = controller;" +
            "}" +
            "}).pipeThrough(new TextEncoderStream());";

        let contextScript = staticContext
            ? `window.__reactRouterContext = ${serverHandoffString};${streamScript}`
            : " ";

        let routeModulesScript = !isStatic
            ? " "
            : `${
                manifest.hmr?.runtime
                    ? `import ${JSON.stringify(manifest.hmr.runtime)};`
                    : ""
            }${!enableFogOfWar ? `import ${JSON.stringify(manifest.url)}` : ""};
${matches
                .map(
                //replace with require ensure call, then a webpack require call, 
                    (match, index) =>
                        `import * as route${index} from ${JSON.stringify(
                            manifest.routes[match.route.id]!.module // need module->moduleID, and imports becomes chunksIDs
                        )};`
                )
                .join("\n")}
  ${
                enableFogOfWar
                    ? // Inline a minimal manifest with the SSR matches
                    `window.__reactRouterManifest = ${JSON.stringify(
                        getPartialManifest(manifest, router),
                        null,
                        2
                    )};`
                    : ""
            }
  window.__reactRouterRouteModules = {${matches
                .map((match, index) => `${JSON.stringify(match.route.id)}:route${index}`)
                .join(",")}};

import(${JSON.stringify(manifest.entry.module)});`;

        return (
            <>
                <script
                    {...props}
                    suppressHydrationWarning
                    dangerouslySetInnerHTML={createHtml(contextScript)}
                    type={undefined}
                />
                <script
                    {...props}
                    suppressHydrationWarning
                    dangerouslySetInnerHTML={createHtml(routeModulesScript)}
                    type="module"
                    async
                />
            </>
        );
        // disabled deps array because we are purposefully only rendering this once
        // for hydration, after that we want to just continue rendering the initial
        // scripts as they were when the page first loaded
        // eslint-disable-next-line
    }, []);

    let routePreloads = matches
        .map((match) => {
            let route = manifest.routes[match.route.id];
            return route ? (route.imports || []).concat([route.module]) : [];
        })
        .flat(1);

    let preloads = isHydrated ? [] : manifest.entry.imports.concat(routePreloads);

    return isHydrated ? null : (
        <>
            {!enableFogOfWar ? (
                <link
                    rel="modulepreload"
                    href={manifest.url}
                    crossOrigin={props.crossOrigin}
                />
            ) : null}
            <link
                rel="modulepreload"
                href={manifest.entry.module}
                crossOrigin={props.crossOrigin}
            />
            {dedupe(preloads).map((path) => (
                <link
                    key={path}
                    rel="modulepreload"
                    href={path}
                    crossOrigin={props.crossOrigin}
                />
            ))}
            {initialScripts}
        </>
    );
}

function dedupe(array: any[]) {
    return [...new Set(array)];
}
