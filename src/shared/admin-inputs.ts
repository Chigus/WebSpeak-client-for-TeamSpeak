export interface AdminSettingsInput {
  target: string;
  serverPassword?: string;
  passwordAction?: "keep" | "replace" | "remove";
  accessMode: "fixed" | "open";
  siteName: string;
  welcomeText: string;
  welcomeTextEn?: string;
  welcomeTextDe?: string;
  welcomeTextRu?: string;
  welcomeTextJa?: string;
  webRtcEnabled: boolean;
  webRtcPublicHost?: string;
  webRtcIpv6Enabled?: boolean;
  webRtcStunServer?: string;
  webRtcUdpStart?: number;
  webRtcUdpEnd?: number;
  relaySettingsAction?: "keep" | "replace" | "remove";
  relayEnabled?: boolean;
  relayName?: string;
  relayTarget?: string;
  relayToken?: string;
  relayTokenAction?: "keep" | "replace" | "remove";
  relayNodes?: RelayNodeInput[];
}

export interface RelayNodeInput {
  id?: string;
  name: string;
  target: string;
  enabled: boolean;
  token?: string;
  tokenAction?: "keep" | "replace" | "remove";
}

export interface ManagedInviteInput {
  channel: string;
  expiresInHours: number;
  maxUses: number;
}
