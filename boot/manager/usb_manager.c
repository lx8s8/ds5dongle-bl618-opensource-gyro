#include "usb_manager.h"
#include "usbd_core.h"
#include "usbd_hid.h"
#include "bflb_irq.h"
#include <string.h>

/* Vendor management interface ONLY; application images retain Sony identity.
 * This prototype uses the existing private test VID/PID, not a public ID claim. */
static const uint8_t report[]={0x06,0x00,0xFF,0x09,0x01,0xA1,0x01,0x85,0x70,0x09,0x01,0x15,0x00,0x26,0xFF,0x00,0x75,0x08,0x95,0x3F,0xB1,0x02,0xC0};
static const uint8_t device_desc[]={
 USB_DEVICE_DESCRIPTOR_INIT(0x0200,0,0,0,0x1209,0x0001,0x0100,1)
};
static const uint8_t config_desc[]={
 USB_CONFIG_DESCRIPTOR_INIT(34,1,1,USB_CONFIG_BUS_POWERED,100),
 9,USB_DESCRIPTOR_TYPE_INTERFACE,0,0,1,USB_DEVICE_CLASS_HID,0,0,0,
 9,HID_DESCRIPTOR_TYPE_HID,0x11,0x01,0,1,HID_DESCRIPTOR_TYPE_HID_REPORT,sizeof report,0,
 USB_ENDPOINT_DESCRIPTOR_INIT(0x81,USB_ENDPOINT_TYPE_INTERRUPT,64,10)
};
static const uint8_t*device_cb(uint8_t speed){(void)speed;return device_desc;}
static const uint8_t*config_cb(uint8_t speed){(void)speed;return config_desc;}
static const char*string_cb(uint8_t speed,uint8_t index){(void)speed;switch(index){case 0:return "\x09\x04";case 1:return "DS5 Project";case 2:return "DS5 Boot Manager (experimental)";case 3:return "DBM1-LCT616-FS";default:return NULL;}}
static const struct usb_descriptor descriptors={.device_descriptor_callback=device_cb,.config_descriptor_callback=config_cb,.string_descriptor_callback=string_cb};
static uint8_t status[64] USB_MEM_ALIGNX, pending[63] USB_MEM_ALIGNX;
static volatile bool ready;
static struct usbd_interface interface;
void usbd_hid_get_report(uint8_t bus,uint8_t intf,uint8_t id,uint8_t type,uint8_t**data,uint32_t*len){
 (void)bus;(void)intf;if(id!=0x70||type!=3){*len=0;return;}*data=status;*len=64;
}
void usbd_hid_set_report(uint8_t bus,uint8_t intf,uint8_t id,uint8_t type,uint8_t*data,uint32_t len){
 (void)bus;(void)intf;if(id!=0x70||type!=3||ready)return;
 if(len==64&&data[0]==id){data++;len--;}
 if(len!=63)return;memcpy(pending,data,63);__asm volatile("":::"memory");ready=true;
}
void usbd_hid_set_idle(uint8_t b,uint8_t i,uint8_t id,uint8_t d){(void)b;(void)i;(void)id;(void)d;}
void usbd_hid_set_protocol(uint8_t b,uint8_t i,uint8_t p){(void)b;(void)i;(void)p;}
void usbd_event_handler(uint8_t bus,uint8_t event){(void)bus;(void)event;}
void bm_usb_start(void){
 status[0]=0x70;usbd_desc_register(0,&descriptors);
 usbd_add_interface(0,usbd_hid_init_intf(0,&interface,report,sizeof report));
 usbd_initialize(0,0x20072000,usbd_event_handler);
}
void bm_usb_stop(void){usbd_deinitialize(0);}
int bm_usb_command(uint8_t*p){if(!ready)return 0;memcpy(p,pending,63);__asm volatile("":::"memory");ready=false;return 1;}
void bm_usb_status(const uint8_t*p){
 /* EP0 only reads this snapshot. Publish with USB IRQ masked to avoid a torn ACK. */
 uintptr_t flags=bflb_irq_save();memcpy(status+1,p,63);bflb_irq_restore(flags);
}
