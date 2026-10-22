<?php
if (!defined('ABSPATH')) exit;

/** The Ordyx shipping method: one instance per courier/way in the shop's zones, priced in WooCommerce. */
class Ordyx_Shipping {
    public static function init() {
        add_action('woocommerce_shipping_init', function () { require_once ORDYX_DIR . 'includes/class-ordyx-shipping-method.php'; });
        add_filter('woocommerce_shipping_methods', function ($methods) { $methods['ordyx'] = 'Ordyx_Shipping_Method'; return $methods; });
    }

    /** rate id ("ordyx:<instance>") → Ordyx type, for every zone. */
    public static function rate_types() {
        $out = [];
        $zones = WC_Shipping_Zones::get_zones();
        $zones[] = ['id' => 0];
        foreach ($zones as $z) {
            $zone = WC_Shipping_Zones::get_zone((int) $z['id']);
            if (!$zone) continue;
            foreach ($zone->get_shipping_methods(true) as $m) {
                if ($m->id !== 'ordyx') continue;
                $out['ordyx:' . $m->get_instance_id()] = (string) $m->get_option('ordyx_type', 'econt_office');
            }
        }
        return $out;
    }

    public static function type_of_instance($instance_id) {
        $map = self::rate_types();
        return $map['ordyx:' . (int) $instance_id] ?? '';
    }

    /** The Ordyx type of the chosen shipping rate in the session (classic checkout), or ''. */
    public static function chosen_type() {
        $chosen = WC()->session ? (array) WC()->session->get('chosen_shipping_methods') : [];
        $map = self::rate_types();
        foreach ($chosen as $rate_id) if (isset($map[$rate_id])) return $map[$rate_id];
        return '';
    }
}
