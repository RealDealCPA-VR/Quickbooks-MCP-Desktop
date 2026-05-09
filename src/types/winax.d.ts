/**
 * Minimal type shim for `winax`.
 *
 * `winax` is a CommonJS native binding that exposes Windows COM automation.
 * Its real surface is broader (Variant, Type, async helpers) — we only
 * declare the small slice [src/session/manager.ts](../session/manager.ts)
 * actually uses: the `Object` constructor that returns a dispatch-style
 * object whose methods we call by name (`OpenConnection2`, `BeginSession`,
 * `ProcessRequest`, `EndSession`, `CloseConnection`).
 *
 * The shim exists so `tsc` can compile before `npm install` has built the
 * native binding (the lazy `await import("winax")` call only resolves at
 * runtime, on Windows + live mode). The package is declared as an
 * `optionalDependency` in package.json so non-Windows installs don't break.
 *
 * The default export is declared in addition to the named `Object` export
 * because the package is CJS — under Node16 ESM resolution, dynamic-import
 * surfaces the module both as `winax.Object` (CJS named-exports detection)
 * and as `winax.default.Object` (interop fallback). manager.ts prefers the
 * named export and falls back to default.
 */
declare module "winax" {
  /**
   * COM dispatch object returned by `new Object("ProgID")`. Members are
   * resolved dynamically against the underlying COM IDispatch interface,
   * so the type is intentionally open. Return values from method calls
   * are `any` because COM dispatch carries no static type information.
   */
  export interface ComDispatchObject {
    [member: string]: any;
  }

  type ObjectCtor = new (progID: string) => ComDispatchObject;

  /** Construct a COM dispatch object by ProgID. */
  export const Object: ObjectCtor;

  const _default: { Object: ObjectCtor };
  export default _default;
}
