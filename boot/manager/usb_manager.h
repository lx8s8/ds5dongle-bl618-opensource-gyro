#ifndef DS5_USB_BOOT_MANAGER_H
#define DS5_USB_BOOT_MANAGER_H
#include <stdint.h>
void bm_usb_start(void);
void bm_usb_stop(void);
int bm_usb_command(uint8_t[63]);
void bm_usb_status(const uint8_t[63]);
#endif
