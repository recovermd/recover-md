/**
 * Tray icon, embedded as a data URL.
 *
 * Inlining it keeps the icon working in every packaging layout (asar, unpacked, dev) with
 * no filesystem lookup, and guarantees the app makes no request to load it (§20).
 */
export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABCklEQVR42u1XSw3EIBBFQiUgoRIqBQlIqIOVgISVgIRKqAASeuK8myZDQiZAgWlDDxzead/A2zc/yox1rCfYEDAENARxY93UQ8B5sTLW/Yx1MsGZ4Td+twAJF3t8E7wl4GzGug+IIglQ6HKPGHeK8LacI7X//MR6UQOYL1sd4Oig48pOwBYR0eQAtn4urBcNLoWxqlYAj9heWrA+PWuJC6lDBApu6XtckKJGQKheZ1puByyZdGRdZAWBKQF7wNlbz3mtgO4p6F6ElDZkd7QhZRD5rUgaRJRRPAOXPIprl9EUsZ20jK7WsUaIcdRTD5ISyCefZDmoJ55kWIiAfOtg/Yqai8d3wRDwGgF/6Z3uh/uQ9hAAAAAASUVORK5CYII=';
