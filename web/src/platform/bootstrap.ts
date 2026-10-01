import { Capacitor } from "@capacitor/core";

export function needsEmbeddedGateway(native: boolean, address: Pick<Location, "hostname" | "port">): boolean {
  return native && !(address.hostname === "127.0.0.1" && address.port === "3040");
}

export async function bootstrapPlatform(mount: () => void): Promise<void> {
  if (needsEmbeddedGateway(Capacitor.isNativePlatform(), location)) {
    const { startAndroidGateway } = await import("./android-gateway.js");
    await startAndroidGateway();
  } else {
    mount();
  }
}
