#include "boot_store.h"
#include "bflb_flash.h"
#include <stdbool.h>
#include <string.h>

#if defined(BOARD_LCTECH_616) && !defined(USB_DIAGNOSTIC_IDENTITY)
static int rd(void*c,uint32_t a,uint8_t*p,size_t n){(void)c;return bflb_flash_read(a,p,n);}
static int er(void*c,uint32_t a,size_t n){(void)c;return bflb_flash_erase(a,n);}
static int wr(void*c,uint32_t a,const uint8_t*p,size_t n){(void)c;return bflb_flash_write(a,(uint8_t*)p,n);}
#endif
bool boot_manager_request(void){
#if defined(BOARD_LCTECH_616) && !defined(USB_DIAGNOSTIC_IDENTITY)
 uint8_t header[256],marker[16];bm_record record;const bm_flash f={NULL,rd,er,wr};
 if(rd(NULL,0,header,sizeof header)||memcmp(header,"BFNP",4)||header[124]!=0||header[125]!=0x20||
    header[126]||header[127]||bm_crc32(header,252)!=(header[252]|header[253]<<8|header[254]<<16|((uint32_t)header[255]<<24)))return false;
 if(rd(NULL,0xFE0,marker,sizeof marker)||memcmp(marker,"DS5-DBM1-ROOT\0\0\0",16)||bm_load(&f,&record)<0)return false;
 /* This only requests the independent manager; no application image or data
  * partition is written here. Old single-firmware devices reject the request. */
 return bm_request_manager(&f,true,&record);
#else
 return false;
#endif
}
