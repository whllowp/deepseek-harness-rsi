declare module '*.module.css' {
  const classes: Readonly<Record<string, string | undefined>> & Record<'stage' | 'companion' | 'bubble' | 'sprite' | 'status' | 'openPanel', string>
  export default classes
}
