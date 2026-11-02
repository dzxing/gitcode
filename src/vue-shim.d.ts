// Plain TypeScript tools need a component type for Vue imports.
// vue-tsc checks the actual SFC template and exposed methods.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}
