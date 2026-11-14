#include "boot_store.h"
#include <string.h>
#include <limits.h>

static uint16_t u16(const uint8_t*p){return p[0]|((uint16_t)p[1]<<8);}
static uint32_t u32(const uint8_t*p){return u16(p)|((uint32_t)u16(p+2)<<16);}
static void p16(uint8_t*p,uint16_t v){p[0]=v;p[1]=v>>8;}
static void p32(uint8_t*p,uint32_t v){p16(p,v);p16(p+2,v>>16);}
uint32_t bm_crc32(const uint8_t*p,size_t n){uint32_t c=~0u;while(n--){c^=*p++;for(int i=0;i<8;i++)c=(c>>1)^(0xEDB88320u&(0u-(c&1)));}return ~c;}
bool bm_decode(const uint8_t*p,bm_record*r){
 if(memcmp(p,"DBM1",4)||u16(p+4)!=1||u16(p+6)!=BM_RECORD_SIZE||p[12]>1||p[13]!=BM_BOARD_LCTECH_FS||
    p[14]>1||p[15]||bm_crc32(p,252)!=u32(p+252))return false;
 for(size_t i=144;i<252;i++)if(p[i])return false;
 bm_record v={.generation=u32(p+8),.selected=p[12],.manage=p[14]};
 for(int i=0;i<2;i++){
  const uint8_t*q=p+16+i*64;bm_image*im=&v.image[i];
  im->address=u32(q);im->capacity=u32(q+4);im->image_length=u32(q+8);
  memcpy(im->sha256,q+12,32);memcpy(im->version,q+44,20);
  if(im->address!=(i?0x210000u:0x10000u)||im->capacity!=(i?0x120000u:0x200000u)||
     im->image_length<0x1004u||im->image_length>im->capacity||!memchr(im->version,0,20))return false;
 }
 *r=v;return true;
}
void bm_encode(const bm_record*r,uint8_t*p){
 memset(p,0,BM_RECORD_SIZE);memcpy(p,"DBM1",4);p16(p+4,1);p16(p+6,BM_RECORD_SIZE);p32(p+8,r->generation);p[12]=r->selected;p[13]=BM_BOARD_LCTECH_FS;p[14]=r->manage;
 for(int i=0;i<2;i++){uint8_t*q=p+16+i*64;const bm_image*im=&r->image[i];p32(q,im->address);p32(q+4,im->capacity);p32(q+8,im->image_length);memcpy(q+12,im->sha256,32);memcpy(q+44,im->version,20);}
 p32(p+252,bm_crc32(p,252));
}
int bm_load(const bm_flash*f,bm_record*r){
 uint8_t p[2][BM_RECORD_SIZE];bm_record a,b;
 bool va=!f->read(f->context,BM_RECORD0,p[0],sizeof p[0])&&bm_decode(p[0],&a);
 bool vb=!f->read(f->context,BM_RECORD1,p[1],sizeof p[1])&&bm_decode(p[1],&b);
 if(!va&&!vb)return -1;
 if(va&&vb&&a.generation==b.generation&&memcmp(p[0],p[1],sizeof p[0]))return -1;
 int index=vb&&(!va||b.generation>a.generation);*r=index?b:a;return index;
}
static bool update(const bm_flash*f,uint8_t slot,uint8_t manage,bm_record*out){
 bm_record r,check;int old=bm_load(f,&r);uint8_t p[BM_RECORD_SIZE],verify[BM_RECORD_SIZE];
 if(old<0||slot>1)return false;
 if(r.selected==slot&&r.manage==manage){*out=r;return true;}
 if(r.generation==UINT32_MAX)return false;
 r.generation++;r.selected=slot;r.manage=manage;bm_encode(&r,p);
 uint32_t address=old?BM_RECORD0:BM_RECORD1;
 if(f->erase(f->context,address,BM_SECTOR_SIZE)||f->write(f->context,address,p,252)||
    f->write(f->context,address+252,p+252,4)||f->read(f->context,address,verify,sizeof verify)||
    memcmp(p,verify,sizeof p)||!bm_decode(verify,&check))return false;
 *out=r;return true;
}
bool bm_select(const bm_flash*f,uint8_t slot,bm_record*out){return update(f,slot,0,out);}
bool bm_request_manager(const bm_flash*f,bool manage,bm_record*out){bm_record r;if(bm_load(f,&r)<0)return false;return update(f,r.selected,manage,out);}

enum { PT_SIZE=16+16*36+4,PT0=0xE000,PT1=0xF000 };
static bool pt_valid(const uint8_t*p){uint16_t n=u16(p+6);return u32(p)==0x54504642u&&u16(p+4)==0&&n&&n<=16&&
 bm_crc32(p,12)==u32(p+12)&&bm_crc32(p+16,n*36)==u32(p+16+n*36);}
static int entry(uint8_t*p,const char*name){int found=-1;for(int i=0;i<u16(p+6);i++)if(!strncmp((char*)p+16+i*36+3,name,9)){if(found>=0)return -1;found=i;}return found;}
bool bm_partition_select(const bm_flash*f,uint8_t slot){
 uint8_t tables[2][PT_SIZE],next[PT_SIZE],verify[PT_SIZE];
 bool valid[2];for(int i=0;i<2;i++)valid[i]=!f->read(f->context,i?PT1:PT0,tables[i],PT_SIZE)&&pt_valid(tables[i]);
 if(slot>1||(!valid[0]&&!valid[1]))return false;
 if(valid[0]&&valid[1]&&u32(tables[0]+8)==u32(tables[1]+8)&&memcmp(tables[0],tables[1],16+u16(tables[0]+6)*36+4))return false;
 int old=valid[1]&&(!valid[0]||u32(tables[1]+8)>u32(tables[0]+8));memcpy(next,tables[old],PT_SIZE);
 const char*names[]={"FW","PSM","KEY","DATA"};
 const uint32_t addresses[4][2]={{0x10000,0x210000},{0x330000,0x3E9000},{0x338000,0x3F1000},{0x33A000,0x3F3000}};
 const uint32_t lengths[4][2]={{0x200000,0x120000},{0x8000,0x8000},{0x2000,0x2000},{0x5000,0x5000}};
 bool changed=false;
 for(int k=0;k<4;k++){
  int i=entry(next,names[k]);if(i<0)return false;uint8_t*p=next+16+i*36;
  if(p[0]!=(k? k+2:0)||p[1]||u32(p+12)!=addresses[k][0]||u32(p+16)!=addresses[k][1]||
     u32(p+20)!=lengths[k][0]||u32(p+24)!=lengths[k][1]||p[2]>1)return false;
  if(p[2]!=slot){p[2]=slot;changed=true;}
 }
 /* Reject all other nonzero extents intersecting either application or either
  * writable bank. Installation removes the legacy overlapping mfg entry. */
 for(int i=0;i<u16(next+6);i++){
  uint8_t*p=next+16+i*36;bool managed=false;for(int k=0;k<4;k++)if(i==entry(next,names[k]))managed=true;
  if(managed)continue;
  for(int j=0;j<2;j++){uint32_t a=u32(p+12+4*j),n=u32(p+20+4*j);if(!n)continue;
   if(a>0x400000u||n>0x400000u-a)return false;
   for(int k=0;k<4;k++)for(int l=0;l<2;l++)if(a<addresses[k][l]+lengths[k][l]&&a+n>addresses[k][l])return false;
  }
 }
 if(!changed)return true;
 if(u32(next+8)==UINT32_MAX)return false;
 p32(next+8,u32(next+8)+1);p32(next+12,bm_crc32(next,12));size_t end=16+u16(next+6)*36;p32(next+end,bm_crc32(next+16,end-16));
 uint32_t address=old?PT0:PT1;
 if(f->erase(f->context,address,BM_SECTOR_SIZE)||f->write(f->context,address,next,end)||
    f->write(f->context,address+end,next+end,4)||f->read(f->context,address,verify,PT_SIZE)||
    memcmp(next,verify,end+4)||!pt_valid(verify))return false;
 return true;
}
bm_gesture_result bm_button(bm_gesture*s,bool pressed,uint32_t elapsed){
 if(pressed&&!s->down){s->down=true;s->pressed_at=elapsed;}
 if(s->down){if(pressed&&elapsed-s->pressed_at>=1000)return BM_MANAGE;
  if(!pressed){s->down=false;return elapsed-s->pressed_at>=40?BM_BOOT_OTHER:BM_WAIT;}}
 return !s->down&&elapsed>=2000?BM_BOOT_CURRENT:BM_WAIT;
}
