#include <stddef.h>
#include <stdint.h>
void *memcpy(void *d,const void *s,size_t n){unsigned char *a=d;const unsigned char*b=s;for(size_t i=0;i<n;i++)a[i]=b[i];return d;}
void *memmove(void *d,const void *s,size_t n){unsigned char*a=d;const unsigned char*b=s;if((uintptr_t)a<(uintptr_t)b)for(size_t i=0;i<n;i++)a[i]=b[i];else while(n){n--;a[n]=b[n];}return d;}
void *memset(void*d,int c,size_t n){unsigned char*a=d;for(size_t i=0;i<n;i++)a[i]=c;return d;}
int memcmp(const void*a,const void*b,size_t n){const unsigned char*x=a,*y=b;for(size_t i=0;i<n;i++)if(x[i]!=y[i])return (int)x[i]-(int)y[i];return 0;}
size_t strlen(const char*s){size_t n=0;while(s[n])n++;return n;}
int strcmp(const char*a,const char*b){while(*a&&*a==*b){a++;b++;}return (unsigned char)*a-(unsigned char)*b;}
char *strchr(const char*s,int c){for(;;s++){if(*s==(char)c)return (char*)s;if(!*s)return NULL;}}
size_t strspn(const char*s,const char*accept){size_t n=0;while(s[n]&&strchr(accept,s[n]))n++;return n;}
size_t strcspn(const char*s,const char*reject){size_t n=0;while(s[n]&&!strchr(reject,s[n]))n++;return n;}
