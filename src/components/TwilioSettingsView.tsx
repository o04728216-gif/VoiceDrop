import React from 'react';
import { CarrierSettingsView } from './CarrierSettingsView';
import { ServerConfig, TwilioConfig, CarriersConfig } from '../types/telephony';

interface TwilioSettingsViewProps {
  serverConfig: ServerConfig | null;
  savedConfig: TwilioConfig | null;
  onSaveConfig: (config: TwilioConfig) => void;
  savedCarriersConfig?: CarriersConfig | null;
  onSaveCarriersConfig?: (config: CarriersConfig) => void;
}

export const TwilioSettingsView: React.FC<TwilioSettingsViewProps> = ({
  serverConfig,
  savedConfig,
  onSaveConfig,
  savedCarriersConfig,
  onSaveCarriersConfig,
}) => {
  return (
    <CarrierSettingsView
      serverConfig={serverConfig}
      savedConfig={savedConfig}
      onSaveConfig={onSaveConfig}
      savedCarriersConfig={savedCarriersConfig || null}
      onSaveCarriersConfig={onSaveCarriersConfig || (() => {})}
    />
  );
};

