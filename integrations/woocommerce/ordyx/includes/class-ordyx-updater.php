<?php
if (!defined('ABSPATH')) exit;

/** Updates from Ordyx (public/integrations/woocommerce.json) through WordPress's own „Update“ button, until the plugin is on WordPress.org. */
class Ordyx_Updater {
    const INFO = '/integrations/woocommerce.json';

    public static function init() {
        add_filter('pre_set_site_transient_update_plugins', [__CLASS__, 'check']);
        add_filter('plugins_api', [__CLASS__, 'info'], 10, 3);
    }

    private static function latest() {
        $cached = get_transient('ordyx_update_info');
        if (is_array($cached)) return $cached;
        $res = wp_remote_get(Ordyx_Api::base() . self::INFO, ['timeout' => 5]);
        $info = [];
        if (!is_wp_error($res) && (int) wp_remote_retrieve_response_code($res) === 200) {
            $d = json_decode((string) wp_remote_retrieve_body($res), true);
            if (is_array($d) && !empty($d['version']) && !empty($d['download'])) $info = $d;
        }
        set_transient('ordyx_update_info', $info, 12 * HOUR_IN_SECONDS);
        return $info;
    }

    public static function check($transient) {
        if (empty($transient->checked)) return $transient;
        $info = self::latest();
        if (!$info || version_compare($info['version'], ORDYX_VERSION, '<=')) return $transient;
        $transient->response['ordyx/ordyx.php'] = (object) [
            'slug' => 'ordyx', 'plugin' => 'ordyx/ordyx.php', 'new_version' => $info['version'],
            'url' => 'https://ordyx.eu', 'package' => $info['download'], 'tested' => $info['tested'] ?? '',
        ];
        return $transient;
    }

    public static function info($result, $action, $args) {
        if ($action !== 'plugin_information' || empty($args->slug) || $args->slug !== 'ordyx') return $result;
        $info = self::latest();
        if (!$info) return $result;
        return (object) [
            'name' => 'Ordyx за WooCommerce', 'slug' => 'ordyx', 'version' => $info['version'], 'author' => 'Ordyx', 'homepage' => 'https://ordyx.eu',
            'download_link' => $info['download'], 'tested' => $info['tested'] ?? '', 'requires' => '6.4', 'requires_php' => '7.4',
            'sections' => ['description' => 'Избор на офис или автомат на Еконт, Спиди и BOX NOW в чекаута; поръчките влизат в Ordyx; товарителницата и проследяването се връщат в WooCommerce.', 'changelog' => $info['changelog'] ?? ''],
        ];
    }
}
