package xyz.yiyangcet.app;

final class UpdatePolicy {
    static boolean newer(String candidate,String current){
        if(candidate==null || current==null || !candidate.matches("\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}") || !current.matches("\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}"))return false;
        String[] a=candidate.split("\\."),b=current.split("\\.");
        for(int i=0;i<3;i++){int left=Integer.parseInt(a[i]),right=Integer.parseInt(b[i]);if(left!=right)return left>right;}
        return false;
    }
    static boolean valid(String version,String current,String file,long bytes,String hash){
        return newer(version,current) && ("yiyang-"+version+"-android.apk").equals(file) && bytes>0 && bytes<=100000000 && hash!=null && hash.matches("[a-f0-9]{64}");
    }
}
