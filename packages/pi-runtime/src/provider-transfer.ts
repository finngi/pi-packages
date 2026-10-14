const TRANSFER = "pi-runtime.provider-transfer.v1";
interface Registration {
  native?: object;
  config?: object;
}
/** Transparent runtime guards preserve the underlying provider's transfer restrictions. */
export function markTransparentProvider<T extends object>(provider: T, original: Registration): T {
  Object.defineProperty(provider, TRANSFER, {
    value: { version: 1, ...original },
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return provider;
}
export function providerRegistrationForTransfer(native?: object, config?: object): Registration {
  const seen = new Set<object>();
  while (native && !seen.has(native)) {
    seen.add(native);
    const marker = Object.getOwnPropertyDescriptor(native, TRANSFER)?.value as
      | (Registration & { version?: unknown })
      | undefined;
    if (!marker || marker.version !== 1) break;
    native = marker.native;
    config = marker.config;
  }
  return { native, config };
}
