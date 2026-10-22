<?php
if (!defined('ABSPATH')) exit;

/** WooCommerce → Ordyx: the shop key, the mode, „Провери връзката“, orders still to be sent. */
class Ordyx_Settings {
    public static function init() {
        add_action('admin_menu', function () {
            add_submenu_page('woocommerce', 'Ordyx', 'Ordyx', 'manage_woocommerce', 'ordyx', [__CLASS__, 'page']);
        });
        add_action('admin_init', function () {
            register_setting('ordyx', 'ordyx_key', ['sanitize_callback' => function ($v) { return trim((string) $v); }]);
            register_setting('ordyx', 'ordyx_mode', ['sanitize_callback' => function ($v) { return $v === 'orders' ? 'orders' : 'checkout'; }]);
            register_setting('ordyx', 'ordyx_complete_on_ship', ['sanitize_callback' => function ($v) { return $v === 'no' ? 'no' : 'yes'; }]);
        });
        add_action('admin_post_ordyx_ping', [__CLASS__, 'ping']);
        add_filter('plugin_action_links_' . plugin_basename(ORDYX_FILE), function ($links) {
            array_unshift($links, '<a href="' . esc_url(admin_url('admin.php?page=ordyx')) . '">Настройки</a>');
            return $links;
        });
        add_action('admin_notices', [__CLASS__, 'notices']);
    }

    public static function ping() {
        if (!current_user_can('manage_woocommerce') || !check_admin_referer('ordyx_ping')) wp_die('Нямате право');
        $r = Ordyx_Api::ping();
        update_option('ordyx_last_ping', ['at' => time(), 'ok' => $r['ok'], 'text' => $r['ok'] ? ('Свързан с магазин „' . ($r['data']['shop']['name'] ?? '') . '“ (' . ($r['data']['shop']['domain'] ?? '') . ')') : $r['error']]);
        wp_safe_redirect(admin_url('admin.php?page=ordyx&pinged=1'));
        exit;
    }

    public static function notices() {
        if (!current_user_can('manage_woocommerce') || Ordyx_Api::key() !== '') return;
        $screen = function_exists('get_current_screen') ? get_current_screen() : null;
        if ($screen && strpos((string) $screen->id, 'ordyx') !== false) return;
        echo '<div class="notice notice-warning"><p><b>Ordyx</b>: поставете ключа на магазина в <a href="' . esc_url(admin_url('admin.php?page=ordyx')) . '">WooCommerce → Ordyx</a>, за да влизат поръчките.</p></div>';
    }

    public static function page() {
        $key = Ordyx_Api::key();
        $mode = Ordyx_Api::mode();
        $ping = get_option('ordyx_last_ping');
        $pending = Ordyx_Sender::pending(30);
        $awaiting = Ordyx_Sender::pending(30, true);
        ?>
        <div class="wrap">
          <h1>Ordyx</h1>
          <?php if (isset($_GET['pinged']) && is_array($ping)): ?>
            <div class="notice <?php echo $ping['ok'] ? 'notice-success' : 'notice-error'; ?>"><p><?php echo esc_html($ping['text']); ?></p></div>
          <?php endif; ?>
          <?php if (isset($_GET['resent'])): ?><div class="notice notice-info"><p>Изпратено отново.</p></div><?php endif; ?>
          <?php if ($mode === 'orders'): ?>
            <div class="notice notice-warning inline"><p><b>Режим „Само поръчките“:</b> поръчките влизат в Ordyx, но клиентите ви избират офис със сегашния ви плъгин и куриерът/офисът се избира ръчно при товарителницата.
              С „Ordyx в чекаута“ получавате избор на офис с карта и „Намери ме“ за Еконт, Спиди и BOX NOW, по-малко грешни адреси и товарителници с едно натискане. Превключете отдолу и добавете методите на Ordyx в Shipping zones.</p></div>
          <?php endif; ?>
          <form method="post" action="options.php">
            <?php settings_fields('ordyx'); ?>
            <table class="form-table" role="presentation">
              <tr><th scope="row"><label for="ordyx_key">Ключ на магазина</label></th>
                <td><input type="text" id="ordyx_key" name="ordyx_key" value="<?php echo esc_attr($key); ?>" class="regular-text code" placeholder="ordyx_live_…" autocomplete="off">
                  <p class="description">Направете го в Ordyx → Интеграции → WooCommerce. Нов ключ там спира стария.</p></td></tr>
              <tr><th scope="row">Режим</th>
                <td><label><input type="radio" name="ordyx_mode" value="checkout" <?php checked($mode, 'checkout'); ?>> <b>Ordyx в чекаута</b> — изборът на офис/автомат на Ordyx (добавете методите на Ordyx в WooCommerce → Settings → Shipping)</label><br>
                  <label><input type="radio" name="ordyx_mode" value="orders" <?php checked($mode, 'orders'); ?>> <b>Само поръчките</b> — чекаутът остава както е; поръчките влизат в Ordyx</label></td></tr>
              <tr><th scope="row">След товарителница</th>
                <td><input type="hidden" name="ordyx_complete_on_ship" value="no"><label><input type="checkbox" name="ordyx_complete_on_ship" value="yes" <?php checked(Ordyx_Api::complete_on_ship()); ?>> Поръчката става „Completed“, когато Ordyx направи товарителницата</label></td></tr>
            </table>
            <?php submit_button('Запази'); ?>
          </form>
          <?php if ($key !== ''): ?>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" style="margin:-10px 0 20px">
              <?php wp_nonce_field('ordyx_ping'); ?><input type="hidden" name="action" value="ordyx_ping">
              <?php submit_button('Провери връзката', 'secondary', 'submit', false); ?>
              <?php if (is_array($ping)): ?><span style="margin-left:10px"><?php echo esc_html(($ping['ok'] ? '✓ ' : '✕ ') . $ping['text']); ?> · <?php echo esc_html(wp_date('d.m.Y H:i', $ping['at'])); ?></span><?php endif; ?>
            </form>
          <?php endif; ?>
          <h2>Поръчки, които не стигнаха до Ordyx</h2>
          <?php if (!$pending): ?><p>Няма — всичко е изпратено.</p><?php else: ?>
            <table class="widefat striped"><thead><tr><th>Поръчка</th><th>Грешка</th><th>Опити</th><th></th></tr></thead><tbody>
            <?php foreach ($pending as $o): ?>
              <tr><td><a href="<?php echo esc_url($o->get_edit_order_url()); ?>">#<?php echo esc_html($o->get_order_number()); ?></a> · <?php echo esc_html($o->get_formatted_billing_full_name()); ?></td>
                <td><?php echo esc_html((string) $o->get_meta('_ordyx_error')); ?></td><td><?php echo (int) $o->get_meta('_ordyx_attempts'); ?></td>
                <td><a class="button" href="<?php echo esc_url(wp_nonce_url(admin_url('admin-post.php?action=ordyx_resend&order=' . $o->get_id()), 'ordyx_resend')); ?>">Изпрати пак</a></td></tr>
            <?php endforeach; ?></tbody></table>
          <?php endif; ?>
          <?php if ($awaiting): ?>
            <h2>Поръчки, които чакат плащане</h2>
            <p class="description">Поръчки с карта или банков превод отиват в Ordyx, щом бъдат платени (или ги маркирате като „Processing“).</p>
            <table class="widefat striped"><thead><tr><th>Поръчка</th><th>Плащане</th><th></th></tr></thead><tbody>
            <?php foreach ($awaiting as $o): ?>
              <tr><td><a href="<?php echo esc_url($o->get_edit_order_url()); ?>">#<?php echo esc_html($o->get_order_number()); ?></a> · <?php echo esc_html($o->get_formatted_billing_full_name()); ?></td>
                <td><?php echo esc_html($o->get_payment_method_title()); ?></td>
                <td><a class="button" href="<?php echo esc_url(wp_nonce_url(admin_url('admin-post.php?action=ordyx_resend&order=' . $o->get_id()), 'ordyx_resend')); ?>">Изпрати като платена</a></td></tr>
            <?php endforeach; ?></tbody></table>
          <?php endif; ?>
          <p class="description" style="margin-top:20px">Плъгин Ordyx <?php echo esc_html(ORDYX_VERSION); ?> · <a href="https://ordyx.eu" target="_blank" rel="noopener">ordyx.eu</a></p>
        </div>
        <?php
    }
}
