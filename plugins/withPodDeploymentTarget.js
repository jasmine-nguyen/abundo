// Xcode 27.1 refuses pod targets below iOS 15, and the react-native-svg and async-storage resource
// bundles still declare 12.4 / 13.0. Raise any pod below the app's own minimum up to it.
// shortcut: blanket raise; drop this plugin once both libraries ship iOS 15+ targets.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const MARKER = 'post_install do |installer|';
const RAISE = `
    app_min = podfile_properties['ios.deploymentTarget'] || '16.4'
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build|
        pod_min = build.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = app_min if pod_min.nil? || Gem::Version.new(pod_min) < Gem::Version.new(app_min)
      end
    end`;

module.exports = (config) => withDangerousMod(config, ['ios', (config) => {
  const file = path.join(config.modRequest.platformProjectRoot, 'Podfile');
  const podfile = fs.readFileSync(file, 'utf8');
  if (!podfile.includes(MARKER)) throw new Error('withPodDeploymentTarget: Podfile has no post_install block');
  if (!podfile.includes(RAISE)) fs.writeFileSync(file, podfile.replace(MARKER, MARKER + RAISE));
  return config;
}]);
