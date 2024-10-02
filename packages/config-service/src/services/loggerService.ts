import { GlobalConfig } from './globalConfig';

export class LoggerService {
  static maskUpEnv(envName, envValue) {
    if (
      envName == GlobalConfig.ENTRIES.OPERATOR_KEY_MAIN.envName ||
      envName == GlobalConfig.ENTRIES.OPERATOR_KEY_ETH_SENDRAWTRANSACTION.envName
    ) {
      return `${envName} = **********${envValue.slice(-4)}`;
    }

    return `${envName} = ${envValue}`;
  }
}
