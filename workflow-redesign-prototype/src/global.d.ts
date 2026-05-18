// Shims for the prototype:
// - React 19's @types/react no longer publishes a global `JSX` namespace; the
//   source uses bare `JSX.Element`, so re-export it globally from React.
// - Allow side-effect imports of plain CSS files (handled by Vite at runtime).
import type { JSX as ReactJSX } from "react";

declare global {
	namespace JSX {
		type Element = ReactJSX.Element;
		type ElementClass = ReactJSX.ElementClass;
		type ElementAttributesProperty = ReactJSX.ElementAttributesProperty;
		type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute;
		type LibraryManagedAttributes<C, P> = ReactJSX.LibraryManagedAttributes<
			C,
			P
		>;
		type IntrinsicAttributes = ReactJSX.IntrinsicAttributes;
		type IntrinsicClassAttributes<T> = ReactJSX.IntrinsicClassAttributes<T>;
		type IntrinsicElements = ReactJSX.IntrinsicElements;
	}
}

declare module "*.css" {}
