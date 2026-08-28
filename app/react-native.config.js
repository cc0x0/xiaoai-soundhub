const ios = require('@react-native-community/cli-platform-ios')
const android = require('@react-native-community/cli-platform-android')
const communityCliPlugin = require('@react-native/community-cli-plugin')

module.exports = {
  commands: [
    ...ios.commands,
    ...android.commands,
    communityCliPlugin.bundleCommand,
    communityCliPlugin.ramBundleCommand,
    communityCliPlugin.startCommand,
  ].filter(Boolean),
  platforms: {
    ios: {
      projectConfig: ios.projectConfig,
      dependencyConfig: ios.dependencyConfig,
    },
    android: {
      projectConfig: android.projectConfig,
      dependencyConfig: android.dependencyConfig,
    },
  },
}
