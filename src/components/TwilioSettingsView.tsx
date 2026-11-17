import React from 'react';
import { CarrierSettingsView } from './CarrierSettingsView';
import { ServerConfig, TwilioConfig, CarriersConfig } from '../types/telephony';

interface TwilioSettingsViewProps {
  serverConfig: ServerConfig | null;
  savedConfig: TwilioConfig | null;
  onSaveConfig: (config: TwilioConfig) => void;
  savedCarriersConfig?: CarriersConfig | null;
  onSaveCarriersConfig?: (config: CarriersConfig) => void;
  deviceLabel?: string;
  onResetDeviceSession?: () => void;
}

export const TwilioSettingsView: React.FC<TwilioSettingsViewProps> = ({
  serverConfig,
  savedConfig,
  onSaveConfig,
  savedCarriersConfig,
  onSaveCarriersConfig,
  deviceLabel,
  onResetDeviceSession,
}) => {
  return (
    <CarrierSettingsView
      serverConfig={serverConfig}
      savedConfig={savedConfig}
      onSaveConfig={onSaveConfig}
      savedCarriersConfig={savedCarriersConfig || null}
      onSaveCarriersConfig={onSaveCarriersConfig || (() => {})}
      deviceLabel={deviceLabel}
      onResetDeviceSession={onResetDeviceSession}
    />
  );
};

