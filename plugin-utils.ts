import type { Babel } from "./babel";
import { t } from "./babel";
import { normalize } from "pathe";

export function validateDestructuredExports(
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

export function invalidDestructureError(name: string) {
  return new Error(`Cannot remove destructured export "${name}"`);
}

export function toFunctionExpression(decl: Babel.FunctionDeclaration) {
  return t.functionExpression(
    decl.id,
    decl.params,
    decl.body,
    decl.generator,
    decl.async
  );
}

export function combineURLs(baseURL: string, relativeURL: string) {
  return relativeURL
    ? `${baseURL.replace(/\/+$/, "")}/${relativeURL.replace(/^\/+/, "")}`
    : baseURL;
}

export function stripFileExtension(file: string) {
  return file.replace(/\.[a-z0-9]+$/i, "");
}

export function createRouteId(file: string) {
  return normalize(stripFileExtension(file));
}
